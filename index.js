'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 暫停並等待使用者在終端機按 Enter
function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCsv(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields) {
  return fields.map(escapeCsv).join(',') + '\r\n';
}

const CSV_HEADERS = [
  '查詢時間', '關鍵字', 'sourceType', '命中品牌', '命中關鍵字',
  '是否命中', '是否排除', '排除原因excludeKeyword', '排除網域excludeDomain',
  '排名', '標題title', '網址url', '摘要snippet', '截圖檔名screenshotFile', '備註note',
];

// ── File / path helpers ──────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 180);
}

function getTimestamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    '_' +
    p(now.getHours()) +
    p(now.getMinutes())
  );
}

function screenshotName(timestamp, keyword, source, brand) {
  return sanitizeFilename(`${timestamp}_${keyword}_${source}_${brand}`) + '.png';
}

// ── Match / filter logic ─────────────────────────────────────────────────────

/**
 * matchTarget()
 *
 * @param {object} target  - one entry from targets.json
 * @param {object} result  - { title, url, snippet, aiText }
 * @returns {{ matched, excluded, matchedKeyword, excludeReason, excludeDomain }}
 */
function matchTarget(target, { title = '', url = '', snippet = '', aiText = '' }) {
  const compareText = [title, url, snippet, aiText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const matchedKeyword = (target.matchKeywords || []).find((kw) =>
    compareText.includes(kw.toLowerCase())
  );
  if (!matchedKeyword) return { matched: false };

  const excludeReason = (target.excludeKeywords || []).find((kw) =>
    compareText.includes(kw.toLowerCase())
  );
  if (excludeReason) return { matched: true, excluded: true, matchedKeyword, excludeReason };

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch (_) {}
  const excludeDomain = (target.excludeDomains || []).find((d) =>
    hostname.includes(d)
  );
  if (excludeDomain) return { matched: true, excluded: true, matchedKeyword, excludeDomain };

  return { matched: true, excluded: false, matchedKeyword };
}

// ── Google DOM extraction (runs inside page.evaluate) ────────────────────────

async function extractOrganicResults(page) {
  try {
    await page.waitForSelector('#search, #rso', { timeout: 12000 });
  } catch (_) {
    return [];
  }

  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const SKIP_SELECTORS = [
      '[data-text-ad]',          // text ads
      '.commercial-unit-desktop-top',
      '.lu_map_section',         // map pack
      '#lu_map',
      '.xpdopen',                // knowledge panel (sometimes)
      '.ULSxyf',                 // top news / stories
      '.g-blk',                  // people also ask (sometimes)
      '.related-question-pair',  // PAA items
      '[data-q]',                // PAA
      '.wQiwMc',                 // PAA
      '.SoaBEf',                 // news carousel
      '.ttfMne',                 // news
      '.JJZKK',                  // news
      '.images_table',           // images
      'g-img',
      '.YiHbdc',                 // video
      '.RzdJxc',                 // video
    ];

    function isSkippable(el) {
      for (const sel of SKIP_SELECTORS) {
        if (el.querySelector(sel) || el.closest(sel) || el.matches(sel)) return true;
      }
      const innerText = (el.innerText || '').toLowerCase();
      if (innerText.startsWith('廣告') || innerText.startsWith('贊助')) return true;
      return false;
    }

    const rso = document.querySelector('#rso') || document.querySelector('#search');
    if (!rso) return results;

    // Broad candidate set — .g is the classic organic result wrapper
    const candidates = Array.from(rso.querySelectorAll('div.g, div.MjjYud > div'));

    for (const block of candidates) {
      if (isSkippable(block)) continue;

      // Need an h3 link to count as an organic result
      const h3 = block.querySelector('h3');
      if (!h3) continue;

      const anchor = h3.closest('a') || h3.querySelector('a') || block.querySelector('a[href]');
      if (!anchor) continue;

      const url = anchor.href || '';
      if (!url.startsWith('http')) continue;
      if (url.includes('google.com/search') || url.includes('google.com/maps')) continue;

      // Ad check via aria-label or class
      const adLabel = block.querySelector('[aria-label="廣告"],[aria-label="Ad"],[aria-label="Sponsored"],.x2VHCd');
      if (adLabel) continue;

      if (seen.has(url)) continue;
      seen.add(url);

      const title = h3.innerText.trim();
      const snippetEl = block.querySelector(
        '.VwiC3b, .s3v9rd, [data-sncf="1"], .lEBKkf, .yDYNvb'
      );
      const snippet = snippetEl ? snippetEl.innerText.trim() : '';

      results.push({ rank: results.length + 1, title, url, snippet });
      if (results.length >= 10) break;
    }

    return results;
  });
}

// ── AI Overview ──────────────────────────────────────────────────────────────

async function extractAiOverview(page) {
  // Try a set of known selectors (Google changes these often)
  const selectors = [
    'div.M8OgIe',           // AI Overview container
    'div.WaaYTe',
    'div.YzLKMe',
    'div[data-attrid="wa:/description"]',
    '.kno-kp',
    'div[jsname="yEVEwb"]',
    'div[data-content-feature="1"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = await el.evaluate((n) => n.innerText).catch(() => '');
      if (text && text.length > 60) {
        return { element: el, text: text.trim() };
      }
    } catch (_) {}
  }

  // Fallback: look for a heading containing 'AI 總覽' / 'AI Overview'
  try {
    const text = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2, h3, div[role="heading"]'));
      for (const h of headings) {
        const t = h.innerText || '';
        if (t.includes('AI 總覽') || t.includes('AI Overview') || t.includes('生成式 AI')) {
          // Walk up to a reasonable container
          const container = h.closest('section, article, [data-attrid], div[jsname]') || h.parentElement;
          return container ? container.innerText.trim() : '';
        }
      }
      return '';
    });
    if (text && text.length > 60) return { element: null, text };
  } catch (_) {}

  return null;
}

// ── AI Mode ──────────────────────────────────────────────────────────────────

async function findAiModeEntry(page) {
  // 1. URL-param approach (udm=50 is AI mode on Google)
  try {
    const el = await page.$('a[href*="udm=50"]');
    if (el) return el;
  } catch (_) {}

  // 2. Text-based search via evaluate
  try {
    const href = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        const txt = (a.innerText || '').trim();
        const h = a.href || '';
        if (
          txt === 'AI 模式' || txt === 'AI Mode' ||
          h.includes('udm=50') || h.includes('ai-mode')
        ) {
          return h;
        }
      }
      return '';
    });
    if (href) {
      return page.locator(`a[href="${href}"]`).first();
    }
  } catch (_) {}

  return null;
}

async function tryAiMode(page, keyword, timestamp, targets, csvStream, screenshotsDir) {
  const entry = await findAiModeEntry(page);
  if (!entry) return false;

  console.log('    AI Mode 入口找到，嘗試進入…');
  try {
    await entry.click();
    await page.waitForTimeout(4000);

    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const currentUrl = page.url();
    let anyHit = false;

    for (const target of targets) {
      const mr = matchTarget(target, {
        title: 'AI Mode',
        url: currentUrl,
        snippet: '',
        aiText: pageText,
      });
      if (!mr.matched) continue;

      let screenshotFile = '';
      if (!mr.excluded) {
        const fname = screenshotName(timestamp, keyword, 'ai_mode', target.name);
        screenshotFile = path.join(screenshotsDir, fname);
        try {
          await page.screenshot({ path: screenshotFile, fullPage: true });
          console.log(`    截圖: ${screenshotFile}`);
        } catch (e) {
          screenshotFile = '';
          console.warn(`    截圖失敗: ${e.message}`);
        }
      }

      csvStream.write(
        csvRow([
          timestamp, keyword, 'ai_mode', target.name,
          mr.matchedKeyword || '',
          'Y',
          mr.excluded ? 'Y' : 'N',
          mr.excludeReason || '',
          mr.excludeDomain || '',
          '',
          'AI Mode',
          currentUrl,
          pageText.substring(0, 300),
          screenshotFile,
          '',
        ])
      );
      anyHit = true;
    }

    if (!anyHit) {
      // No target hit in AI Mode — log a no-match row
      csvStream.write(
        csvRow([timestamp, keyword, 'ai_mode', '', '', 'N', '', '', '', '', 'AI Mode', currentUrl, '', '', 'AI Mode 已進入，無品牌命中'])
      );
    }

    return true;
  } catch (e) {
    console.warn(`    AI Mode 進入失敗: ${e.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const keywords = JSON.parse(fs.readFileSync('keywords.json', 'utf8'));
  const targets = JSON.parse(fs.readFileSync('targets.json', 'utf8'));

  const screenshotsDir = 'screenshots';
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir);

  const csvPath = 'result.csv';
  const csvStream = fs.createWriteStream(csvPath, { encoding: 'utf8' });
  csvStream.write('﻿'); // BOM — makes Excel open UTF-8 correctly
  csvStream.write(csvRow(CSV_HEADERS));

  const browser = await chromium.launch({
    headless: false,
    args: ['--lang=zh-TW'],
  });

  console.log(`開始搜尋，共 ${keywords.length} 個關鍵字，${targets.length} 個目標品牌\n`);

  for (const keyword of keywords) {
    const timestamp = getTimestamp();
    console.log(`[${timestamp}] 搜尋: ${keyword}`);

    let context, page;
    try {
      // New incognito-like context per keyword
      context = await browser.newContext({
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      });
      page = await context.newPage();

      const searchUrl =
        'https://www.google.com/search?q=' +
        encodeURIComponent(keyword) +
        '&hl=zh-TW&gl=TW&pws=0&nfpr=1';

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // ── CAPTCHA check ──
      const isCaptcha = await page.evaluate(() => {
        return (
          !!document.querySelector('form#captcha-form') ||
          !!document.querySelector('#recaptcha') ||
          document.title.toLowerCase().includes('unusual traffic') ||
          document.body.innerText.includes('我不是機器人') ||
          document.body.innerText.includes("I'm not a robot")
        );
      });
      if (isCaptcha) {
        console.warn(`\n  ⚠️  偵測到 CAPTCHA 驗證碼！`);
        console.warn(`  請在瀏覽器視窗完成驗證後，回到終端機按 Enter 繼續。`);
        console.warn(`  （若直接按 Enter 略過，此關鍵字將記錄為驗證碼未完成）\n`);
        await waitForEnter('  完成驗證後請按 Enter：');

        // 確認驗證是否已通過
        const stillCaptcha = await page.evaluate(() => {
          return (
            !!document.querySelector('form#captcha-form') ||
            !!document.querySelector('#recaptcha') ||
            document.title.toLowerCase().includes('unusual traffic') ||
            document.body.innerText.includes('我不是機器人') ||
            document.body.innerText.includes("I'm not a robot")
          );
        }).catch(() => true);

        if (stillCaptcha) {
          console.warn(`  驗證碼仍未通過，跳過此關鍵字。`);
          csvStream.write(csvRow([timestamp, keyword, '', '', '', '', '', '', '', '', '', '', '', '', 'CAPTCHA 驗證未完成，跳過']));
          await context.close();
          continue;
        }
        console.log(`  驗證通過，繼續處理…\n`);
        await page.waitForTimeout(1500);
      }

      // ════════════════════════════════════════
      // 1. Google Top 10 Organic Results
      // ════════════════════════════════════════
      const organicResults = await extractOrganicResults(page);
      console.log(`  自然搜尋結果: ${organicResults.length} 筆`);

      if (organicResults.length === 0) {
        csvStream.write(csvRow([timestamp, keyword, 'google_top10', '', '', 'N', '', '', '', '', '', '', '', '', '找不到自然搜尋結果']));
      }

      // For each result × each target, decide match/exclude/screenshot
      // We only screenshot the page ONCE per (keyword, sourceType, brand) combination
      const shotTaken = new Set();

      for (const result of organicResults) {
        for (const target of targets) {
          const mr = matchTarget(target, result);
          if (!mr.matched) continue;

          let screenshotFile = '';
          const shotKey = `top10_${target.name}`;

          if (!mr.excluded && !shotTaken.has(shotKey)) {
            const fname = screenshotName(timestamp, keyword, 'google_top10', target.name);
            screenshotFile = path.join(screenshotsDir, fname);
            try {
              await page.screenshot({ path: screenshotFile, fullPage: true });
              console.log(`  截圖 (top10/${target.name}): ${fname}`);
              shotTaken.add(shotKey);
            } catch (e) {
              screenshotFile = '';
              console.warn(`  截圖失敗: ${e.message}`);
            }
          }

          csvStream.write(
            csvRow([
              timestamp,
              keyword,
              'google_top10',
              target.name,
              mr.matchedKeyword || '',
              'Y',
              mr.excluded ? 'Y' : 'N',
              mr.excludeReason || '',
              mr.excludeDomain || '',
              result.rank,
              result.title,
              result.url,
              result.snippet,
              screenshotFile,
              '',
            ])
          );
        }
      }

      // ════════════════════════════════════════
      // 2. AI Overview
      // ════════════════════════════════════════
      const aiOverview = await extractAiOverview(page);
      if (aiOverview) {
        console.log(`  AI Overview 偵測到`);
        let anyAiHit = false;

        for (const target of targets) {
          const mr = matchTarget(target, {
            title: 'AI Overview',
            url: '',
            snippet: '',
            aiText: aiOverview.text,
          });
          if (!mr.matched) continue;

          let screenshotFile = '';
          const shotKey = `ai_overview_${target.name}`;

          if (!mr.excluded && !shotTaken.has(shotKey)) {
            const fname = screenshotName(timestamp, keyword, 'ai_overview', target.name);
            screenshotFile = path.join(screenshotsDir, fname);
            try {
              if (aiOverview.element) {
                await aiOverview.element.screenshot({ path: screenshotFile });
              } else {
                await page.screenshot({ path: screenshotFile, fullPage: false });
              }
              console.log(`  截圖 (ai_overview/${target.name}): ${fname}`);
              shotTaken.add(shotKey);
            } catch (e) {
              try {
                await page.screenshot({ path: screenshotFile, fullPage: false });
                shotTaken.add(shotKey);
              } catch (_) {
                screenshotFile = '';
              }
            }
          }

          csvStream.write(
            csvRow([
              timestamp,
              keyword,
              'ai_overview',
              target.name,
              mr.matchedKeyword || '',
              'Y',
              mr.excluded ? 'Y' : 'N',
              mr.excludeReason || '',
              mr.excludeDomain || '',
              '',
              'AI Overview',
              '',
              aiOverview.text.substring(0, 400),
              screenshotFile,
              '',
            ])
          );
          anyAiHit = true;
        }

        if (!anyAiHit) {
          csvStream.write(
            csvRow([timestamp, keyword, 'ai_overview', '', '', 'N', '', '', '', '', 'AI Overview', '', aiOverview.text.substring(0, 200), '', 'AI Overview 有出現，但無品牌命中'])
          );
        }
      } else {
        console.log(`  AI Overview 未出現`);
        csvStream.write(
          csvRow([timestamp, keyword, 'ai_overview', '', '', 'N', '', '', '', '', '', '', '', '', 'AI Overview 未出現'])
        );
      }

      // ════════════════════════════════════════
      // 3. AI Mode
      // ════════════════════════════════════════
      const aiModeFound = await tryAiMode(
        page, keyword, timestamp, targets, csvStream, screenshotsDir
      );
      if (!aiModeFound) {
        console.log(`  AI Mode 入口未出現`);
        csvStream.write(
          csvRow([timestamp, keyword, 'ai_mode', '', '', 'N', '', '', '', '', '', '', '', '', 'AI Mode 入口未出現'])
        );
      }

    } catch (err) {
      console.error(`  [錯誤] ${keyword}: ${err.message}`);
      csvStream.write(
        csvRow([timestamp, keyword, '', '', '', '', '', '', '', '', '', '', '', '', `執行錯誤: ${err.message}`])
      );
    } finally {
      if (context) {
        try { await context.close(); } catch (_) {}
      }
    }

    // Random delay between searches to reduce bot detection risk
    const delay = 3000 + Math.floor(Math.random() * 3000);
    console.log(`  等待 ${delay}ms 後繼續…\n`);
    await new Promise((r) => setTimeout(r, delay));
  }

  await browser.close();
  csvStream.end();
  console.log(`\n完成！`);
  console.log(`結果: ${csvPath}`);
  console.log(`截圖: ${screenshotsDir}/`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

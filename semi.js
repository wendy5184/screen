'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Helpers（與 index.js 相同邏輯）──────────────────────────────────────────

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
  const excludeDomain = (target.excludeDomains || []).find((d) => hostname.includes(d));
  if (excludeDomain) return { matched: true, excluded: true, matchedKeyword, excludeDomain };

  return { matched: true, excluded: false, matchedKeyword };
}

// ── Terminal I/O ─────────────────────────────────────────────────────────────

function askUser(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Page helpers ─────────────────────────────────────────────────────────────

async function isCaptchaPage(page) {
  return page.evaluate(() => {
    return (
      !!document.querySelector('form#captcha-form') ||
      !!document.querySelector('#recaptcha') ||
      document.title.toLowerCase().includes('unusual traffic') ||
      document.body.innerText.includes('我不是機器人') ||
      document.body.innerText.includes("I'm not a robot")
    );
  }).catch(() => false);
}

async function extractPageInfo(page) {
  return page.evaluate(() => {
    const title = document.title || '';
    const url = location.href || '';
    const bodyText = document.body ? document.body.innerText.substring(0, 8000) : '';
    const linkHrefs = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter((h) => h.startsWith('http'))
      .join(' ');
    return { title, url, bodyText, linkHrefs };
  });
}

function keywordFromUrl(url) {
  try {
    const q = new URL(url).searchParams.get('q');
    return q || '手動搜尋';
  } catch (_) {
    return '手動搜尋';
  }
}

// ── CSV setup（新檔寫 headers，已存在則 append）────────────────────────────

function openCsvStream(csvPath) {
  if (!fs.existsSync(csvPath)) {
    const s = fs.createWriteStream(csvPath, { encoding: 'utf8' });
    s.write('﻿'); // BOM
    s.write(csvRow(CSV_HEADERS));
    return s;
  }
  return fs.createWriteStream(csvPath, { encoding: 'utf8', flags: 'a' });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const targets = JSON.parse(fs.readFileSync('targets.json', 'utf8'));
  const screenshotsDir = 'screenshots';
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir);

  const csvStream = openCsvStream('result.csv');

  const browser = await chromium.launch({ headless: false, args: ['--lang=zh-TW'] });
  const context = await browser.newContext({
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('\n=== 半自動截圖模式 ===');
  console.log(`targets: ${targets.map((t) => t.name).join('、')}`);
  console.log('瀏覽器已開啟 Google 首頁。\n');

  while (true) {
    const input = await askUser(
      '請在瀏覽器中手動搜尋關鍵字，或完成 CAPTCHA 驗證。\n完成後回到終端機按 Enter 繼續（輸入 q 結束）：'
    );
    if (input.toLowerCase() === 'q') break;

    const timestamp = getTimestamp();

    // ── CAPTCHA check ──
    if (await isCaptchaPage(page)) {
      console.warn('\n  目前頁面疑似仍為 CAPTCHA，請手動完成驗證後再按 Enter。\n');
      csvStream.write(
        csvRow([timestamp, '手動搜尋', 'semi_auto', '', '', '', '', '', '', '', '', page.url(), '', '', '目前頁面疑似仍為 CAPTCHA，請手動完成驗證後再按 Enter'])
      );
      continue;
    }

    // ── Extract page content ──
    let pageInfo;
    try {
      pageInfo = await extractPageInfo(page);
    } catch (e) {
      console.warn(`  頁面讀取失敗: ${e.message}`);
      csvStream.write(csvRow([timestamp, '手動搜尋', 'semi_auto', '', '', '', '', '', '', '', '', page.url(), '', '', `頁面讀取失敗: ${e.message}`]));
      continue;
    }

    const { title, url, bodyText, linkHrefs } = pageInfo;
    const keyword = keywordFromUrl(url);
    console.log(`\n  頁面: ${title} | 關鍵字: ${keyword}`);

    // ── Match targets ──
    let anyHit = false;
    let sharedScreenshot = ''; // 同一頁多品牌命中時共用同一張截圖

    for (const target of targets) {
      const mr = matchTarget(target, {
        title,
        url,
        snippet: bodyText.substring(0, 2000),
        aiText: linkHrefs,
      });

      if (!mr.matched) continue;
      anyHit = true;

      let screenshotFile = '';
      if (!mr.excluded) {
        if (!sharedScreenshot) {
          const fname = sanitizeFilename(`${timestamp}_semi-auto_${target.name}`) + '.png';
          sharedScreenshot = path.join(screenshotsDir, fname);
          try {
            await page.screenshot({ path: sharedScreenshot, fullPage: true });
            console.log(`  截圖: ${sharedScreenshot}`);
          } catch (e) {
            console.warn(`  截圖失敗: ${e.message}`);
            sharedScreenshot = '';
          }
        }
        screenshotFile = sharedScreenshot;
        console.log(`  命中: ${target.name}（關鍵字: ${mr.matchedKeyword}）`);
      } else {
        console.log(`  命中但排除: ${target.name}（${mr.excludeReason || mr.excludeDomain}）`);
      }

      csvStream.write(
        csvRow([
          timestamp,
          keyword,
          'semi_auto',
          target.name,
          mr.matchedKeyword || '',
          'Y',
          mr.excluded ? 'Y' : 'N',
          mr.excludeReason || '',
          mr.excludeDomain || '',
          '',
          title,
          url,
          bodyText.substring(0, 300),
          screenshotFile,
          '',
        ])
      );
    }

    if (!anyHit) {
      console.log('  未偵測到品牌命中。');
      csvStream.write(
        csvRow([timestamp, keyword, 'semi_auto', '', '', 'N', '', '', '', '', title, url, bodyText.substring(0, 300), '', '頁面無品牌命中'])
      );
    }

    console.log('');
  }

  csvStream.end();
  await browser.close();
  console.log('\n結束。結果已寫入 result.csv\n');
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

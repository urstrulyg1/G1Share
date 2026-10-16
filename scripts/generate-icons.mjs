#!/usr/bin/env node
/**
 * G1Viewer — Desktop Visual Branding & Icon Suite Generator
 *
 * Generates:
 *  - build/icon-2048.png (2048x2048 master asset)
 *  - build/icon.png (1024x1024 master icon)
 *  - build/icons/ (Linux standard XDG multi-resolution icons: 16x16 to 1024x1024)
 *  - build/icon.icns (macOS multi-resolution iconset Retina)
 *  - build/icon.ico (Windows multi-resolution icon: 16, 24, 32, 48, 64, 128, 256)
 *  - build/background.tiff & build/dmg-background@2x.png (macOS 4K Retina DMG background)
 *  - build/installerSidebar.bmp & build/uninstallerSidebar.bmp (Windows 4K-supersampled NSIS sidebar)
 *  - build/installerHeader.bmp (Windows 4K-supersampled NSIS header)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicSvg = path.join(rootDir, 'public', 'icon.svg');
const buildDir = path.join(rootDir, 'build');
const iconsDir = path.join(buildDir, 'icons');
const tmpDir = path.join(rootDir, '.icon-gen-tmp');

const requiredAssets = [
  path.join(buildDir, 'icon-2048.png'),
  path.join(buildDir, 'icon.png'),
  path.join(buildDir, 'icon.icns'),
  path.join(buildDir, 'icon.ico'),
  path.join(buildDir, 'background.tiff'),
  path.join(buildDir, 'installerHeader.bmp'),
  path.join(buildDir, 'installerSidebar.bmp'),
  path.join(buildDir, 'uninstallerSidebar.bmp'),
  path.join(iconsDir, '256x256.png')
];

if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

if (!fs.existsSync(publicSvg)) {
  console.error(`❌ Source icon not found at: ${publicSvg}`);
  process.exit(1);
}

// Clean temporary folder
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

console.log('🎨 [G1Viewer] Generating 4K Ultra-Clarity desktop branding & Linux icon suite...');

// Find Chrome/Chromium executable
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

let chromePath = chromeCandidates.find(p => fs.existsSync(p));

const missingAssets = requiredAssets.filter(asset => !fs.existsSync(asset));
if (!chromePath) {
  if (missingAssets.length > 0) {
    console.error(`Chrome/Chromium is unavailable and required assets are missing: ${missingAssets.join(', ')}`);
    process.exit(1);
  }
  console.warn('Chrome runtime is unavailable; keeping checked-in packaging assets.');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

const svgSource = fs.readFileSync(publicSvg, 'utf8');

// 1. 4K Master Icon Template (2048x2048)
const icon4kHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 2048px; height: 2048px; background: transparent; overflow: hidden; }
    svg { width: 2048px; height: 2048px; display: block; shape-rendering: geometricPrecision; text-rendering: geometricPrecision; }
  </style>
</head>
<body>
  ${svgSource}
</body>
</html>`;

// 2. 4K DMG Background Template (2720x1800 — 4x of 680x450)
const dmgBg4kHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 2720px;
    height: 1800px;
    background: radial-gradient(circle at 50% 20%, rgba(56, 189, 248, 0.16) 0%, rgba(15, 23, 42, 0.98) 55%, #030712 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', Roboto, sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }
  .border-glow {
    position: absolute;
    inset: 0;
    border: 4px solid rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .grid-pattern {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(to right, rgba(56, 189, 248, 0.03) 2px, transparent 2px),
                      linear-gradient(to bottom, rgba(56, 189, 248, 0.03) 2px, transparent 2px);
    background-size: 80px 80px;
    mask-image: radial-gradient(ellipse at 50% 45%, black 40%, transparent 80%);
  }
  .header {
    position: absolute;
    top: 110px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .logo-box {
    width: 180px;
    height: 180px;
    border-radius: 44px;
    background: linear-gradient(135deg, #0F172A 0%, #030712 100%);
    border: 3px solid rgba(56, 189, 248, 0.5);
    box-shadow: 0 24px 72px rgba(0, 0, 0, 0.65), 0 0 48px rgba(56, 189, 248, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 28px;
  }
  .logo-box svg { width: 130px; height: 130px; }
  .title {
    font-size: 96px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #FFFFFF;
    text-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
  }
  .title span { color: #38BDF8; }
  .subtitle {
    margin-top: 14px;
    font-size: 42px;
    font-weight: 500;
    color: #94A3B8;
    letter-spacing: -0.015em;
  }
  .pedestal {
    position: absolute;
    width: 400px;
    height: 400px;
    border-radius: 84px;
    top: 1000px;
    transform: translate(-50%, -50%);
  }
  .pedestal-left {
    left: 680px;
    border: 4px dashed rgba(56, 189, 248, 0.5);
    background: radial-gradient(circle, rgba(56, 189, 248, 0.14) 0%, transparent 70%);
  }
  .pedestal-right {
    left: 2040px;
    border: 4px dashed rgba(255, 255, 255, 0.28);
    background: radial-gradient(circle, rgba(255, 255, 255, 0.08) 0%, transparent 70%);
  }
  .arrow-container {
    position: absolute;
    left: 1000px;
    top: 920px;
    width: 720px;
    height: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .footer-pill {
    position: absolute;
    bottom: 110px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.92);
    border: 2px solid rgba(56, 189, 248, 0.4);
    backdrop-filter: blur(24px);
    border-radius: 9999px;
    padding: 24px 68px;
    display: flex;
    align-items: center;
    gap: 24px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .footer-text {
    font-size: 40px;
    font-weight: 600;
    color: #F1F5F9;
    letter-spacing: -0.01em;
  }
  .footer-badge {
    background: #0284C7;
    color: #FFFFFF;
    font-size: 28px;
    font-weight: 800;
    padding: 6px 22px;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
</head>
<body>
  <div class="border-glow"></div>
  <div class="grid-pattern"></div>
  <div class="header">
    <div class="logo-box">${svgSource}</div>
    <h1 class="title">G1<span>Viewer</span></h1>
    <p class="subtitle">Consent-First Remote Desktop &amp; Ultra-Low Latency Streaming</p>
  </div>
  <div class="pedestal pedestal-left"></div>
  <div class="pedestal pedestal-right"></div>
  <div class="arrow-container">
    <svg width="720" height="160" viewBox="0 0 720 160" fill="none">
      <defs>
        <linearGradient id="arrow-grad-4k" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#0284C7" stop-opacity="0.4"/>
          <stop offset="60%" stop-color="#38BDF8"/>
          <stop offset="100%" stop-color="#7DD3FC"/>
        </linearGradient>
        <filter id="arrow-glow-4k" x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="10" result="glow"/>
          <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <path d="M 30 80 C 160 30, 290 130, 440 80 S 580 50, 620 80" stroke="url(#arrow-grad-4k)" stroke-width="14" stroke-linecap="round" fill="none" filter="url(#arrow-glow-4k)"/>
      <path d="M 610 52 L 670 80 L 610 108 Z" fill="#38BDF8" filter="url(#arrow-glow-4k)"/>
    </svg>
  </div>
  <div class="footer-pill">
    <span class="footer-badge">Install</span>
    <span class="footer-text">Drag G1Viewer into Applications</span>
  </div>
</body>
</html>`;

// 3. 4K NSIS Sidebar (656x1256 — 4x of 164x314)
const sidebar4kHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 656px;
    height: 1256px;
    background: linear-gradient(175deg, #0F172A 0%, #09101D 45%, #030712 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', Roboto, sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    position: relative;
    padding: 72px 56px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    -webkit-font-smoothing: antialiased;
  }
  .glow {
    position: absolute;
    top: -100px;
    left: -100px;
    width: 500px;
    height: 500px;
    background: radial-gradient(circle, rgba(56, 189, 248, 0.25) 0%, transparent 70%);
    pointer-events: none;
  }
  .logo-box {
    width: 152px;
    height: 152px;
    border-radius: 36px;
    background: linear-gradient(135deg, #0F172A 0%, #030712 100%);
    border: 3px solid rgba(56, 189, 248, 0.5);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 32px rgba(56, 189, 248, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 40px;
  }
  .logo-box svg { width: 112px; height: 112px; }
  .title {
    font-size: 64px;
    font-weight: 800;
    color: #FFFFFF;
    letter-spacing: -0.02em;
  }
  .title span { color: #38BDF8; }
  .desc {
    margin-top: 20px;
    font-size: 32px;
    line-height: 1.4;
    color: #94A3B8;
    font-weight: 450;
  }
  .footer {
    border-top: 2px solid rgba(255, 255, 255, 0.1);
    padding-top: 36px;
  }
  .badge {
    display: inline-block;
    background: rgba(56, 189, 248, 0.14);
    border: 2px solid rgba(56, 189, 248, 0.35);
    color: #38BDF8;
    font-size: 24px;
    font-weight: 700;
    padding: 8px 20px;
    border-radius: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .footer-text {
    margin-top: 16px;
    font-size: 26px;
    color: #64748B;
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div>
    <div class="logo-box">${svgSource}</div>
    <h1 class="title">G1<span>Viewer</span></h1>
    <p class="desc">Consent-First Remote Desktop &amp; Ultra-Low Latency Streaming</p>
  </div>
  <div class="footer">
    <span class="badge">Consent-First Security</span>
    <p class="footer-text">Direct P2P &bull; E2E Encrypted &bull; No Telemetry</p>
  </div>
</body>
</html>`;

// 4. 4K NSIS Header (600x228 — 4x of 150x57)
const header4kHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 600px;
    height: 228px;
    background: linear-gradient(90deg, #0F172A 0%, #030712 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', Roboto, sans-serif;
    color: #F8FAFC;
    overflow: hidden;
    padding: 32px 40px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 32px;
    -webkit-font-smoothing: antialiased;
  }
  .text-side { text-align: right; }
  .title { font-size: 40px; font-weight: 800; color: #FFFFFF; }
  .title span { color: #38BDF8; }
  .sub { font-size: 26px; color: #94A3B8; margin-top: 4px; }
  .logo-box {
    width: 104px;
    height: 104px;
    border-radius: 24px;
    background: #0F172A;
    border: 2px solid rgba(56, 189, 248, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .logo-box svg { width: 80px; height: 80px; }
</style>
</head>
<body>
  <div class="text-side">
    <div class="title">G1<span>Viewer</span></div>
    <div class="sub">Setup Wizard</div>
  </div>
  <div class="logo-box">${svgSource}</div>
</body>
</html>`;

// Render with puppeteer-core
import puppeteer from 'puppeteer-core';

async function renderAssets() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // 1. Master Icon (2048x2048)
    await page.setViewport({ width: 2048, height: 2048 });
    await page.setContent(icon4kHtml);
    const icon2048 = await page.screenshot({ omitBackground: true, type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'icon-2048.png'), icon2048);
    fs.writeFileSync(path.join(tmpDir, 'master-2048.png'), icon2048);

    // Master Icon (1024x1024)
    await page.setViewport({ width: 1024, height: 1024 });
    await page.setContent(icon4kHtml);
    const icon1024 = await page.screenshot({ omitBackground: true, type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'icon.png'), icon1024);

    // 2. 4K DMG Background (2720x1800)
    await page.setViewport({ width: 2720, height: 1800 });
    await page.setContent(dmgBg4kHtml);
    const dmgBg4k = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'dmg-background-4k.png'), dmgBg4k);
    fs.writeFileSync(path.join(tmpDir, 'dmg-bg-4k.png'), dmgBg4k);

    // 2x DMG Background (1360x900)
    await page.setViewport({ width: 1360, height: 900 });
    await page.setContent(dmgBg4kHtml);
    const dmgBg2x = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'dmg-background@2x.png'), dmgBg2x);

    // 1x DMG Background (680x450)
    await page.setViewport({ width: 680, height: 450 });
    await page.setContent(dmgBg4kHtml);
    const dmgBg1x = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'dmg-background.png'), dmgBg1x);

    // 3. NSIS Sidebar (164x314 and 4K)
    await page.setViewport({ width: 164, height: 314 });
    await page.setContent(sidebar4kHtml);
    const sidebarPng = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'installerSidebar.png'), sidebarPng);

    // 4. NSIS Header (150x57)
    await page.setViewport({ width: 150, height: 57 });
    await page.setContent(header4kHtml);
    const headerPng = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(buildDir, 'installerHeader.png'), headerPng);

    console.log('  ✓ Rendered master vector PNG graphics');
  } finally {
    await browser.close();
  }

  // 5. Generate Linux multi-resolution icon suite
  const linuxSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
  for (const sz of linuxSizes) {
    execFileSync('sips', ['-z', String(sz), String(sz), path.join(buildDir, 'icon.png'), '--out', path.join(iconsDir, `${sz}x${sz}.png`)]);
  }
  console.log('  ✓ Generated build/icons/ (10 Linux XDG standard resolutions: 16x16 to 1024x1024)');

  // 6. Generate macOS .icns multi-resolution bundle
  const iconsetDir = path.join(tmpDir, 'icon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });
  const icnsSpecs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];
  for (const [filename, sz] of icnsSpecs) {
    execFileSync('sips', ['-z', String(sz), String(sz), path.join(buildDir, 'icon.png'), '--out', path.join(iconsetDir, filename)]);
  }
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')]);
  console.log('  ✓ Generated build/icon.icns (Apple Retina multi-resolution bundle)');

  // 7. Generate Windows .ico container
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = icoSizes.map(sz => fs.readFileSync(path.join(iconsDir, `${sz}x${sz}.png`)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);

  let offset = 6 + (16 * icoSizes.length);
  const dirEntries = icoSizes.map((sz, i) => {
    const buf = pngBuffers[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sz === 256 ? 0 : sz, 0);
    entry.writeUInt8(sz === 256 ? 0 : sz, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    return entry;
  });
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...dirEntries, ...pngBuffers]));
  console.log('  ✓ Generated build/icon.ico (Windows multi-resolution container)');

  // 8. Generate macOS background.tiff
  try {
    execFileSync('tiffutil', [
      '-cathidpicheck',
      path.join(buildDir, 'dmg-background.png'),
      path.join(buildDir, 'dmg-background@2x.png'),
      '-out',
      path.join(buildDir, 'background.tiff')
    ]);
    console.log('  ✓ Generated build/background.tiff (Apple Retina 4K DMG background)');
  } catch (err) {
    console.warn('  ⚠️ tiffutil warning:', err.message);
  }

  // 9. Generate Windows NSIS BMPs
  execFileSync('sips', ['-s', 'format', 'bmp', path.join(buildDir, 'installerSidebar.png'), '--out', path.join(buildDir, 'installerSidebar.bmp')]);
  execFileSync('sips', ['-s', 'format', 'bmp', path.join(buildDir, 'installerSidebar.png'), '--out', path.join(buildDir, 'uninstallerSidebar.bmp')]);
  execFileSync('sips', ['-s', 'format', 'bmp', path.join(buildDir, 'installerHeader.png'), '--out', path.join(buildDir, 'installerHeader.bmp')]);
  console.log('  ✓ Generated build/installerSidebar.bmp & build/installerHeader.bmp');

  console.log('✅ [G1Viewer] All desktop visual packaging assets generated successfully.');
}

renderAssets()
  .catch(err => {
    console.error('Error generating assets:', err);
    process.exit(1);
  })
  .finally(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

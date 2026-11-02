#!/usr/bin/env python3
"""Precise mobile layout probe: verify VLM-flagged issues with real measurements."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"

with sync_playwright() as p:
    browser = p.chromium.launch()
    m = browser.new_page(viewport={"width": 390, "height": 844})
    m.goto(BASE, wait_until="networkidle")
    m.wait_for_selector("text=Amina", timeout=30000)

    result = m.evaluate("""() => {
      const out = {};
      out.docScrollW = document.documentElement.scrollWidth;
      out.innerW = window.innerWidth;
      // intro paragraph clipping?
      const intro = [...document.querySelectorAll('p')].find(p => p.textContent.includes('Keycloak OIDC'));
      if (intro) {
        out.intro = {
          rectRight: Math.round(intro.getBoundingClientRect().right),
          rectLeft: Math.round(intro.getBoundingClientRect().left),
          scrollW: intro.scrollWidth, clientW: intro.clientWidth,
          clipped: intro.scrollWidth > intro.clientWidth,
          color: getComputedStyle(intro).color,
          fontSize: getComputedStyle(intro).fontSize,
        };
      }
      // account type badges right edge
      const badges = [...document.querySelectorAll('span')].filter(s => /^(CU|SB)$/.test(s.textContent.trim()));
      out.badges = badges.slice(0, 4).map(b => ({
        text: b.textContent.trim(),
        right: Math.round(b.getBoundingClientRect().right),
        clipped: b.getBoundingClientRect().right > window.innerWidth,
      }));
      // list rows spacing
      const rows = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('Amina Wanjiru'));
      if (rows[0]) {
        const r = rows[0].getBoundingClientRect();
        out.row = { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      }
      // tour sub-line contrast
      const tour = [...document.querySelectorAll('div')].find(d => d.textContent.trim().startsWith('8 steps'));
      if (tour) out.tourSub = { color: getComputedStyle(tour).color };
      // horizontal overflow offenders
      const offenders = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 || r.left < -1) {
          offenders.push(el.tagName + '.' + String(el.className).slice(0, 60) + ' right=' + Math.round(r.right));
        }
      });
      out.offenders = offenders.slice(0, 10);
      return out;
    }""")
    import json
    print(json.dumps(result, indent=1))
    browser.close()

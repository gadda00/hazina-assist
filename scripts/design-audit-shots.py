#!/usr/bin/env python3
"""Screenshot the current Hazina UI states (login, chat, console) for design audit."""
import sys, pathlib
from playwright.sync_api import sync_playwright

OUT = pathlib.Path("/tmp/shots")
OUT.mkdir(exist_ok=True)
BASE = "http://localhost:3000"

with sync_playwright() as p:
    browser = p.chromium.launch()
    # Desktop
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("text=Amina", timeout=30000)
    page.screenshot(path=str(OUT / "before-login.png"), full_page=False)

    # login as customer
    page.get_by_role("button").filter(has_text="Amina Wanjiru").first.click()
    page.wait_for_selector("text=Hazina Assistant", timeout=30000)
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "before-chat.png"))
    # send a quick prompt
    page.get_by_role("button").filter(has_text="Salio").first.click()
    page.wait_for_timeout(3000)
    page.screenshot(path=str(OUT / "before-chat-answered.png"))

    # sign out, login as officer
    page.get_by_role("button").filter(has_text="Sign out").first.click()
    page.wait_for_selector("text=Demo officer console", timeout=30000)
    page.get_by_role("button").filter(has_text="Officer Njeri").first.click()
    page.wait_for_selector("text=DEMO OFFICER MODE", timeout=30000)
    page.wait_for_timeout(2000)
    page.screenshot(path=str(OUT / "before-console.png"))

    # Mobile login
    m = browser.new_page(viewport={"width": 390, "height": 844})
    m.goto(BASE, wait_until="networkidle")
    m.wait_for_selector("text=Amina", timeout=30000)
    m.screenshot(path=str(OUT / "before-login-mobile.png"))
    browser.close()
print("done:", sorted(f.name for f in OUT.glob("*.png")))

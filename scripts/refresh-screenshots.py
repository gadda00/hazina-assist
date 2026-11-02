#!/usr/bin/env python3
"""Refresh docs/screenshots/* after the "The Vault" redesign.

Captures the README-referenced shots against the running dev server:
login, chat (fee answer), officer console tabs, and the tour banner.
Overwrites only the brand-relevant images; leaves deeper e2e shots alone.
"""
import sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
OUT = "docs/screenshots"

def shot(page, name):
    page.screenshot(path=f"{OUT}/{name}", full_page=True)
    print(f"saved {name}")

def wait_text(page, text, timeout=15000):
    page.wait_for_selector(f"text={text}", timeout=timeout)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-proxy-server", "--no-sandbox", "--disable-dev-shm-usage"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()

        # 1. login screen (logo hero + directory)
        page.goto(BASE, wait_until="networkidle")
        wait_text(page, "Sign in to the vault")
        time.sleep(0.8)
        shot(page, "login.png")

        # 2. login as Amina → fee question
        page.click("button:has-text('Amina Wanjiru')")
        page.wait_for_selector("text=guardrails live", timeout=20000)
        time.sleep(1.5)
        page.click("button:has-text('M-Pesa fee (Sheng)')")
        try:
            page.wait_for_selector("text=/tariff guide|KES \\d+/i", timeout=30000)
        except Exception as e:
            print(f"fee answer wait: {e}")
        time.sleep(1.5)
        shot(page, "chat-fee.png")

        # accounts rail is on the right of the same view
        shot(page, "chat-accounts.png")

        # 3. officer console tabs
        page.click("button:has-text('Sign out')")
        wait_text(page, "Sign in to the vault")
        time.sleep(0.8)
        page.click("button:has-text('Officer Njeri')")
        page.wait_for_selector("text=awaiting a human decision", timeout=20000)
        time.sleep(1.2)
        shot(page, "console-approvals.png")

        page.click("[role=tab]:has-text('Loan packs')")
        time.sleep(1.5)
        shot(page, "console-loanpack.png")

        page.click("[role=tab]:has-text('Audit chain')")
        time.sleep(1.2)
        page.click("button:has-text('Verify chain')")
        time.sleep(2.0)
        shot(page, "verify-audit.png")

        page.click("[role=tab]:has-text('Evaluations')")
        time.sleep(1.5)
        shot(page, "verify-evals.png")

        page.click("[role=tab]:has-text('Monitoring')")
        time.sleep(1.5)
        shot(page, "verify-monitoring.png")

        # 4. tour banner on the chat surface (start tour as Amina, step 1)
        page.click("button:has-text('Sign out')")
        page.wait_for_selector("text=Start the guided tour", timeout=15000)
        time.sleep(0.6)
        page.click("button:has-text('Start the guided tour')")
        page.wait_for_selector("[data-testid='tour-banner']", timeout=15000)
        time.sleep(0.8)
        shot(page, "tour-banner-chat.png")

        browser.close()
    print("done")

if __name__ == "__main__":
    main()

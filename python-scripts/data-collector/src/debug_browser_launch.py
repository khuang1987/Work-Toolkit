
from utils.playwright_manager import PlaywrightManager
import logging
import traceback

logging.basicConfig(level=logging.INFO)

print("Diagnostic: Attempting to launch Playwright with User Profile...")

try:
    manager = PlaywrightManager(
        headless=False,
        use_user_profile=True,
        browser_type="chrome"
    )
    # Start effectively calls _start_with_user_profile internally
    manager.start()
    
    print("SUCCESS: Browser launched with user profile!")
    manager.close()
except Exception as e:
    print("\nFAILURE: Could not launch with user profile.")
    print(f"Error Type: {type(e).__name__}")
    print(f"Error Message: {str(e)}")
    print("\nFull Traceback:")
    traceback.print_exc()

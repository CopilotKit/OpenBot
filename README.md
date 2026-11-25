# PR #2189 UI screenshots

Latest positioning updates: `191f72ce17f6c973b5550071b21af54bd22778eb`, captured on 2026-11-25. Cloud sign-in, Connect to work, Self-Contained requirements/install, and the update operation have been re-spaced without changing their visual style or copy.

This gallery has 25 screenshots: 10 refreshed positioning captures from the standalone real-main browser fixture, and 15 earlier captures from Workbench at `f47ccabc0cc1ad7ffbcbb3c51fe0e5361f639d2c` for the other layouts. Native/API boundaries are simulated; earlier Workbench captures include preview window controls. Booking uses the live Calendly widget; availability was viewed without booking a meeting.

Viewport is 1000×800 unless a compact 720×560 image is named. Windows captures include an extra 32px title bar. Source and capture method are recorded per image in `manifest.json`.

The refreshed spacing passed six focused existing layout browser cases (100 assertions), scoped formatting/lint, and the Desktop production build. This branch hosts images and capture metadata only.

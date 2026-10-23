# LabDash

A private lab notebook that runs on your phone: projects, tasks and deadlines, a photo and notes log, and a lab mode that walks you through a protocol and records each sample's measurements with an automatic, per-project sample ID.

**This repository holds only the app's code. It contains no data.**

## How your data is protected

- Everything is encrypted on the device before it is stored or sent anywhere. A random 256-bit data key encrypts the notebook with AES-GCM. That key is itself encrypted with a key derived from your passphrase (PBKDF2-SHA256, 600,000 rounds).
- Sync stores only the encrypted notebook (`vault.json`) and encrypted photos (`img/*.json`) in a **private** repository you own. The app refuses to sync to a public repository.
- The GitHub access token is kept inside this device's encrypted copy. It is never synced or uploaded.
- The page only talks to its own address and `api.github.com` (enforced by its Content Security Policy). There is no analytics and no third-party code apart from the bundled SheetJS reader for Excel import.
- There is no passphrase reset. Keep the passphrase in a password manager.

## Laptop copy into OneDrive

`laptop/labdash_sync.py` downloads the encrypted notebook, decrypts it on your laptop and writes an Excel workbook plus your photos (named by sample ID) into OneDrive. It runs every 15 minutes as a Windows scheduled task. See `laptop/SETUP.txt`.

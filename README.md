# ClassTrack — Student Class Attendance Management System

A browser-based student attendance management application developed for a TVET-college context.

> **Project status:** Frontend/local-storage prototype. This repository preserves the original project interface and source files; it is not a production-ready institution-wide attendance service.

## Features

- Lecturer registration and sign-in interface
- Student and class management
- Attendance marking: Present, Absent, Late and Excused
- Attendance summaries and low-attendance alerts
- Searchable reports and printable registers
- CSV export
- JSON backup and restore
- QR-code session and student check-in interface
- Responsive interface

## Technology

- HTML5
- CSS3
- Vanilla JavaScript
- Browser `localStorage` and `sessionStorage`
- QRCode.js loaded from a CDN

## Run locally

1. Download or clone this repository.
2. Open `index.html` in a modern browser, or use the Live Server extension in Visual Studio Code.
3. The built-in demonstration administrator credentials are present in the client-side source. They are for local demonstration only, not secure authentication.

## Important limitations

This version stores data in the browser on the current device. It does not use a central database, server-side authentication or cloud synchronisation.

- Browser storage is local to the device and browser.
- Student check-in on another device will not automatically synchronise with a lecturer's browser.
- PINs and access checks are handled client-side and are not secure authentication.
- Browser storage can be cleared or modified.
- Do not use this version to store real student records or deploy it for institution-wide attendance management.

A production version would need secure server-side authentication and authorisation, a shared database, validated QR sessions, backups, audit logging and privacy safeguards.

## Portfolio note

The original `index.html`, `style.css` and `script.js` files are included without redesigning the interface. This README and `.gitignore` are added to make the project easier to understand and maintain on GitHub.

Use fictional sample data in screenshots. If the project was made for or with another person or institution, obtain permission and agree on attribution before publishing it publicly.

## Author

Add or confirm the contributor/author attribution before making this repository public.

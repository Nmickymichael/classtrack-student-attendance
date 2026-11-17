# ClassTrack — Student Class Attendance Management System

A browser-based Student Class Attendance Management System designed to support **universities, TVET colleges, technical training institutions and other higher-learning institutions** in managing student class attendance.

ClassTrack provides a digital approach to organizing student records, managing classes, recording attendance, monitoring attendance patterns and generating attendance reports. It aims to simplify attendance management for lecturers, instructors and educational institutions.

> **Project status:** Frontend/local-storage prototype. This repository preserves the original project interface and source files; it is not a production-ready institution-wide attendance service.

## Target Institutions

ClassTrack is designed to be adaptable to different educational environments, including:

- Universities
- TVET colleges
- Technical and vocational training institutions
- Other colleges and higher-learning institutions

The system provides a centralized-style interface for managing classroom attendance activities, with the current version storing data locally in the browser.

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

## Run Locally

1. Download or clone this repository.
2. Open `index.html` in a modern browser, or use the Live Server extension in Visual Studio Code.
3. The built-in demonstration administrator credentials are present in the client-side source. They are for local demonstration only, not secure authentication.

## Important Limitations

This version stores data in the browser on the current device. It does not use a central database, server-side authentication or cloud synchronisation.

- Browser storage is local to the device and browser.
- Student check-in on another device will not automatically synchronise with a lecturer's browser.
- PINs and access checks are handled client-side and are not secure authentication.
- Browser storage can be cleared or modified.
- Do not use this version to store real student records or deploy it for institution-wide attendance management.

A production version would need secure server-side authentication and authorisation, a shared database, validated QR sessions, backups, audit logging and privacy safeguards.

## Future Development

Potential improvements include:

- Integration with a secure cloud database.
- Secure lecturer and administrator authentication.
- Synchronised attendance records across multiple devices.
- Institution-specific configuration for universities and TVET colleges.
- Improved QR-code attendance verification.
- Enhanced analytics and attendance reporting.

## Portfolio Note

The original `index.html`, `style.css` and `script.js` files are included without redesigning the interface. This README and `.gitignore` are added to make the project easier to understand and maintain on GitHub.

Use fictional sample data in screenshots. If the project was made for or with another person or institution, obtain permission and agree on attribution before publishing it publicly.

## Author

**Michael Harrison Muthee Muriithi**

Project Developer | ICT Student

ClassTrack — Student Class Attendance Management System

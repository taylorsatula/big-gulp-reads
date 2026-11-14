# Changelog

## [1.0.2] - 2026-11-14

- Rerelease of 1.0.1: npm holds 1.0.0 and 1.0.1 in its first-release pending queue behind the 0.0.0-stage placeholder, where they can be neither approved (no stage-id exists) nor published over, so this version carries the same content forward under a fresh number.

## [1.0.1] - 2026-11-14

- Fixed the oversized-first-line notice to report the line's actual size instead of repeating the limit.

## [1.0.0] - 2026-11-14

- Initial release: read tool override with configurable KB/line limits (default 200KB / 5000 lines) and /big-gulp-reads command.

; Project Console CLI Start Menu shortcut (2026-08-26).
; Included via electron-builder's nsis.include (desktop/package.json -> build.nsis.include):
; customInstall runs during installation, customUnInstall during uninstall. The shortcut
; opens a terminal running resources\cli.cmd, which launches the terminal chat client with
; the bundled Electron runtime as Node - full CLI access from a .exe-only install.
; NOTE: oneClick installs place the app's own shortcut at the Programs ROOT (no per-app
; folder), so the CLI shortcut must live there too or CreateShortCut silently no-ops.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Project Console CLI.lnk" "$INSTDIR\resources\cli.cmd" "" "$INSTDIR\Project Console.exe" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Project Console CLI.lnk"
!macroend
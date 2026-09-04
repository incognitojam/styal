!include "getProcessInfo.nsh"

Var pid
Var IsPowerShellAvailable

!macro customCheckAppRunning
  # styal and T3 Code may run side by side. electron-builder normally checks
  # every process below $INSTDIR when PowerShell is available, which can treat
  # T3 Code as styal when Windows carries forward a historical shared install
  # path. Force its exact executable-name fallback so only styal is stopped.
  StrCpy $IsPowerShellAvailable 1
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  # The styal install has completed and registered its new GUID. Remove the
  # earlier fork and pre-fix styal registrations without running either old
  # uninstaller: their directory-wide process check can stop upstream T3 Code.
  # TODO(2026-10-08): Remove this migration after the two-month compatibility window.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\0122c0ea-801f-5352-a48e-ce98c31bc2d9"
  DeleteRegKey HKCU "Software\0122c0ea-801f-5352-a48e-ce98c31bc2d9"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\48e3dbfe-4d90-524c-acdc-304cac9a97b1"
  DeleteRegKey HKCU "Software\48e3dbfe-4d90-524c-acdc-304cac9a97b1"
!macroend

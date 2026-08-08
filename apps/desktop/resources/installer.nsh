!macro customInstall
  # The separated install has completed and registered its new GUID. Remove the
  # earlier fork's stale registration without running its uninstaller, because
  # that old installation directory may still belong to upstream T3 Code.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\48e3dbfe-4d90-524c-acdc-304cac9a97b1"
  DeleteRegKey HKCU "Software\48e3dbfe-4d90-524c-acdc-304cac9a97b1"
!macroend

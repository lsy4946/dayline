!macro customInit
  ; The dedicated Dayline update helper owns the visible progress experience.
  ; Keep the updater-owned NSIS process in the background while preserving the
  ; normal assisted wizard when the user opens Setup manually.
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend

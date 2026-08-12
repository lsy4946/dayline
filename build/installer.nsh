!macro customInit
  ; Older Dayline builds launch an update with --updated but without /S.
  ; Treat only that updater-owned path as silent so the very next upgrade is
  ; unattended, while a manually opened Setup keeps the normal install wizard.
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend

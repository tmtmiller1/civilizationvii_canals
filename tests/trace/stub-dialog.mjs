// stub-dialog.mjs - the game's dialog box manager, for the sequence traces: each dialog is written to the trace.
export const DialogBoxManager = {
  createDialog_Confirm: (o) => globalThis.__traceNote(`dialog confirm ${o.body}`),
  createDialog_MultiOption: (o) => globalThis.__traceNote(`dialog options ${o.body}`),
};

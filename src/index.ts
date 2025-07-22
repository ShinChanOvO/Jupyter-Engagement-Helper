// @ts-nocheck 
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCell } from '@jupyterlab/cells';

/* ---------- Types & buffer ---------- */
interface EngageEvent {
  ts: number;                       // Unix epoch (ms)
  evt: 'open' | 'runCell' | 'error';
  nb: string;                       // Notebook path
  cell?: number;                    // Execution count
  ename?: string;                   // Error name
}
const buffer: EngageEvent[] = [];   // In-memory event buffer
let lastFlush = 0;                  // Timestamp of last flush

/* ---------- Main plugin ---------- */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-engagement-helper',
  autoStart: true,
  requires: [INotebookTracker],
activate: (app, tracker) => {
  console.log('Engagement Helper activated');
console.log('ENGAGE-BUILD-STAMP', Date.now());
  /* attach to notebooks already open when JupyterLab starts */
tracker.forEach((panel: NotebookPanel) => {
  panel.sessionContext.ready.then(() => attachHandlers(panel));
});

  /* attach to notebooks opened after activation */
  tracker.widgetAdded.connect((_s, panel) => {
    panel.sessionContext.ready.then(() => attachHandlers(panel));
  });

  /* optional: update currentPanel when user switches tabs */
  tracker.currentChanged.connect((_s, panel) => {
    if (panel) {
      panel.sessionContext.ready.then(() => attachHandlers(panel));
    }
  });

  window.addEventListener('beforeunload', flush);
}


};
export default plugin;

/* ---------- Attach handlers to a notebook ---------- */
function attachHandlers(panel: NotebookPanel) {
  const nbPath = panel.context.path;
  Private.currentPanel = panel;

  log({ ts: Date.now(), evt: 'open', nb: nbPath });

  // Listen for kernel messages to detect runCell / error
  panel.sessionContext.session?.kernel?.anyMessage?.connect((_s, msg) => {
    const t = Date.now();
    if (msg.header.msg_type === 'execute_input') {
      log({ ts: t, evt: 'runCell', nb: nbPath, cell: msg.content.execution_count });
    } else if (msg.header.msg_type === 'error') {
      log({
        ts: t,
        evt: 'error',
        nb: nbPath,
        cell: msg.parent_header?.content?.execution_count,
        ename: msg.content.ename
      });
    }
  });
}

/* ---------- Buffer logic ---------- */
function log(e: EngageEvent) {
  buffer.push(e);
  if (buffer.length >= 200 || Date.now() - lastFlush > 5000) {
    flush();
  }
}

/* ---------- Flush to notebook metadata ---------- */
function flush() {
  if (!buffer.length || !Private.currentPanel) return;

  const panel = Private.currentPanel;
  const meta = panel.content.model!.metadata;
  const prev = (meta.get('engage') as any) ?? {};
  const merged = [...(prev.events ?? []), ...buffer].slice(-5000);
  meta.set('engage', { ...prev, events: merged });

  // Build summary numbers
  const summary = {
    runCnt: merged.filter(e => e.evt === 'runCell').length,
    errCnt: merged.filter(e => e.evt === 'error').length,
    activeMs: merged.length ? merged[merged.length - 1].ts - merged[0].ts : 0
  };
  updateSummaryCell(panel, summary);

  buffer.length = 0;
  lastFlush = Date.now();
}

/* ---------- Auto-generated summary markdown ---------- */
function updateSummaryCell(
  panel: NotebookPanel,
  s: { runCnt: number; errCnt: number; activeMs: number }
) {
  const nb = panel.content;
  const TAG = 'engage-summary';
  let cell = nb.widgets.find(
    w =>
      w.model?.type === 'markdown' &&
      (w.model?.metadata.get('tags') as string[] | undefined)?.includes(TAG)
  ) as MarkdownCell | undefined;

  const md = `
<!-- auto -->
**Engagement Summary (auto-generated)**

| Metric | Value |
|--------|-------|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |
`.trim();

  if (cell) {
    cell.model!.value.text = md;
  } else {
    const m = nb.model!.contentFactory.createMarkdownCell({});
    m.value.text = md;
    m.metadata.set('tags', [TAG, 'hide_input', 'hide_output']);
    nb.model!.cells.push(m);
  }
}

/* ---------- Private helper namespace ---------- */
namespace Private {
  export let currentPanel: NotebookPanel | null = null;
}

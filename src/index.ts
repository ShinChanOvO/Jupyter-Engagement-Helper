// ---------------------------------------------------------------------------
// @ts-nocheck   – quick demo, disable strict TS checks
// ---------------------------------------------------------------------------
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { MarkdownCellModel } from '@jupyterlab/cells';

/* ------------------------------------------------------------------ */
/*  Types & global buffer                                             */
/* ------------------------------------------------------------------ */
interface EngageEvent {
  ts: number;
  evt: 'open' | 'runCell' | 'error';
  nb: string;
  cell?: number;
  ename?: string;
}
const buffer: EngageEvent[] = [];
let   lastFlush = 0;

/* ------------------------------------------------------------------ */
/*  Plugin definition                                                 */
/* ------------------------------------------------------------------ */
const plugin: JupyterFrontEndPlugin<void> = {
  id       : 'jupyter-engagement-helper',
  autoStart: true,
  requires : [INotebookTracker],
  activate : (_app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[plugin] activated', Date.now());

    tracker.restored.then(() => {
      tracker.forEach(p => p.sessionContext.ready.then(() => attach(p)));
    });

    tracker.widgetAdded.connect((_s, p) =>
      p.sessionContext.ready.then(() => attach(p)));

    tracker.currentChanged.connect((_s, p) => {
      if (p) p.sessionContext.ready.then(() => attach(p));
    });

    window.addEventListener('beforeunload', flush);
  }
};
export default plugin;

/* ------------------------------------------------------------------ */
/*  Attach listeners to one notebook                                  */
/* ------------------------------------------------------------------ */
function attach(panel: NotebookPanel) {
  const nbPath = panel.context.path;
  console.log('[attach] on', nbPath);
  Private.current = panel;

  /* record one “open” */
  panel.context.ready.then(() => {
    log({ ts: Date.now(), evt: 'open', nb: nbPath });
    flush();
  });

  /* kernel traffic */
  panel.sessionContext.session?.kernel?.anyMessage?.connect((_s, a) => {
    const m = (a as any).msg;
    if (!m?.header) return;

    const t = Date.now();
    if (m.header.msg_type === 'execute_input') {
      log({ ts: t, evt: 'runCell', nb: nbPath,
            cell: m.content.execution_count });
    } else if (m.header.msg_type === 'error') {
      log({ ts: t, evt: 'error', nb: nbPath,
            cell : m.parent_header?.content?.execution_count,
            ename: m.content.ename });
    }
  });

  panel.revealed.then(() => requestAnimationFrame(flush));
}

/* ------------------------------------------------------------------ */
/*  Buffer util                                                       */
/* ------------------------------------------------------------------ */
function log(e: EngageEvent) {
  buffer.push(e);
  if (buffer.length >= 200 || Date.now() - lastFlush > 5_000) flush();
}

/* ------------------------------------------------------------------ */
/*  Persist + cumulative summary                                      */
/* ------------------------------------------------------------------ */
function flush() {
  if (!buffer.length || !Private.current) return;

  const panel = Private.current;
  const nbMd  = panel.content?.model?.metadata as any;
  if (!nbMd) return;                                // still not ready

  /* read existing storage */
  const oldStore = nbMd.get ? nbMd.get('engage') ?? {} : nbMd.engage ?? {};
  const oldSum   = oldStore.summary ?? { runCnt:0, errCnt:0, startTs:null };

  /* delta inside this flush */
  let deltaRun = 0, deltaErr = 0;
  buffer.forEach(e => {
    if (e.evt === 'runCell') deltaRun++;
    else if (e.evt === 'error') deltaErr++;
  });

  /* accumulate */
  const startTs  = oldSum.startTs ?? buffer[0].ts;
  const lastTs   = buffer[buffer.length - 1].ts;
  const summary  = {
    runCnt : oldSum.runCnt + deltaRun,
    errCnt : oldSum.errCnt + deltaErr,
    startTs,
    activeMs: lastTs - startTs
  };

  /* keep events ≤ 5 000 */
  const events = [...(oldStore.events ?? []), ...buffer].slice(-5000);

  /* write back */
  const nextStore = { events, summary };
  nbMd.set ? nbMd.set('engage', nextStore) : nbMd.engage = nextStore;

  updateSummary(panel, summary);     // refresh / insert markdown

  buffer.length = 0;
  lastFlush     = Date.now();
}

/* ------------------------------------------------------------------ */
/*  Refresh or insert summary markdown                                */
/* ------------------------------------------------------------------ */
function updateSummary(
  panel  : NotebookPanel,
  s      : { runCnt:number; errCnt:number; activeMs:number }
) {
  const nb  = panel.content;
  const TAG = 'engage-summary';

  /* locate existing */
  const cellWidget: any = nb.widgets.find(w => {
    if (w.model?.type !== 'markdown') return false;
    const meta: any = w.model.metadata;
    const tags = meta.get ? meta.get('tags') : meta.tags;
    return Array.isArray(tags) && tags.includes(TAG);
  });

  const md = `
<!-- auto -->
**Engagement Summary (auto-generated)**

| Metric | Value |
|--------|-------|
| Run count | ${s.runCnt} |
| Error count | ${s.errCnt} |
| Active time (min) | ${Math.round(s.activeMs / 60000)} |
  `.trim();

  /* ---------------- update existing ---------------- */
  if (cellWidget) {
    const model: any = cellWidget.model;
    if (model.sharedModel?.setSource) model.sharedModel.setSource(md);
    else                              model.value.text = md;
    return;
  }

  /* ---------------- need a new cell ---------------- */
  const nbModel: any = nb.model;
  let newModel: any;

  // try JLab ≥4.1 factory
  if (nbModel?.contentFactory?.createMarkdownCell) {
    newModel = nbModel.contentFactory.createMarkdownCell({});
  } else if (nbModel?.factory?.createMarkdownCell) {   // 4.2+
    newModel = nbModel.factory.createMarkdownCell({});
  } else {
    newModel = new MarkdownCellModel({});
  }

  /* set source + tags */
  if (newModel.sharedModel?.setSource) newModel.sharedModel.setSource(md);
  else                                 newModel.value.text = md;

  const mMeta: any = newModel.metadata;
  if (mMeta?.set) mMeta.set('tags', [TAG, 'hide_input', 'hide_output']);

  /* insert safely (only if API 可用) */
  if (nbModel?.cells?.insert) {
    nbModel.cells.insert(0, newModel);
  } else if (nbModel?.sharedModel?.insertCell) {
    nbModel.sharedModel.insertCell(0, {
      cell_type : 'markdown',
      source    : md,
      metadata  : { tags:[TAG,'hide_input','hide_output'] }
    });
  } else {
    console.warn('[summary] no cell-insert API, skip creating cell');
  }
}

/* ------------------------------------------------------------------ */
namespace Private {
  export let current: NotebookPanel | null = null;
}

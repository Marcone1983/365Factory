'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface SymbolInfo {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
}

export interface IdeFile {
  readonly path: string;
  readonly language: string;
  readonly size: number;
  readonly symbols: readonly SymbolInfo[];
  readonly summary: string;
}

export interface IdeVersion {
  readonly version: number;
  readonly label: string;
  readonly summary: string;
  readonly authorType: string;
  readonly createdAt: string;
  readonly diffStats: { files: number; additions: number; deletions: number };
}

function csrfToken(): string {
  return document.cookie.split('; ').find((part) => part.startsWith('adaf_csrf='))?.split('=')[1] ?? '';
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': csrfToken() };
}

interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly children: TreeNode[];
  readonly file?: IdeFile;
}

/** Groups flat workspace paths into a directory tree for the explorer. */
function buildTree(files: readonly IdeFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const currentPath = segments.slice(0, index + 1).join('/');
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path: currentPath, children: [], ...(isLeaf ? { file } : {}) };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      const aDir = a.children.length > 0;
      const bDir = b.children.length > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function Tree({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const isDirectory = node.children.length > 0;

  if (node.path === '') {
    return (
      <>
        {node.children.map((child) => (
          <Tree key={child.path} node={child} depth={0} activePath={activePath} onOpen={onOpen} />
        ))}
      </>
    );
  }

  return (
    <>
      <button
        className={`tree-row${node.path === activePath ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (isDirectory ? setCollapsed((v) => !v) : onOpen(node.path))}
      >
        <span className="faint">{isDirectory ? (collapsed ? '▸' : '▾') : ' '}</span> {node.name}
        {node.file ? <span className="faint tree-size">{(node.file.size / 1024).toFixed(1)}k</span> : null}
      </button>
      {isDirectory && !collapsed
        ? node.children.map((child) => (
            <Tree key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
          ))
        : null}
    </>
  );
}

export function IdeClient({
  projectId,
  files,
  versions: initialVersions,
  canWrite,
}: {
  projectId: string;
  files: readonly IdeFile[];
  versions: readonly IdeVersion[];
  canWrite: boolean;
}): React.ReactElement {
  const [activePath, setActivePath] = useState<string | null>(files[0]?.path ?? null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [versions, setVersions] = useState<readonly IdeVersion[]>(initialVersions);
  const [panel, setPanel] = useState<'symbols' | 'history' | 'diff'>('symbols');
  const [diff, setDiff] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(
    () => (filter.trim() === '' ? files : files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))),
    [files, filter],
  );
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const activeFile = files.find((f) => f.path === activePath) ?? null;
  const dirty = content !== original;

  const open = useCallback(
    async (path: string): Promise<void> => {
      setStatus(null);
      setActivePath(path);
      const response = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        setStatus('That file could not be read.');
        setContent('');
        setOriginal('');
        return;
      }
      const body = (await response.json()) as { content: string };
      setContent(body.content);
      setOriginal(body.content);
    },
    [projectId],
  );

  useEffect(() => {
    if (activePath) void open(activePath);
    // Opening the first file once on mount is intentional; later opens go
    // through the explorer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(): Promise<void> {
    if (!activePath || !dirty) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/files`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ path: activePath, content }),
      });
      const body = (await response.json()) as { error?: string; saved?: boolean; version?: number; diff?: string; reason?: string };
      if (!response.ok) {
        setStatus(body.error ?? 'The file could not be saved.');
        return;
      }
      if (!body.saved) {
        setStatus(body.reason ?? 'Nothing to save.');
        return;
      }
      setOriginal(content);
      setStatus(`Saved as version ${body.version}.`);
      if (body.diff) {
        setDiff(body.diff);
        setPanel('diff');
      }
      await refreshVersions();
    } catch {
      setStatus('The console could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshVersions(): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/versions`);
    if (!response.ok) return;
    const body = (await response.json()) as { versions: IdeVersion[] };
    setVersions(body.versions);
  }

  async function showDiff(version: number): Promise<void> {
    if (!activePath) {
      setStatus('Open a file first — the diff is shown per file.');
      return;
    }
    const response = await fetch(`/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ action: 'diff', version, path: activePath }),
    });
    const body = (await response.json()) as { error?: string; diff?: string };
    if (!response.ok) {
      setStatus(body.error ?? 'That diff could not be produced.');
      return;
    }
    setDiff(body.diff && body.diff.trim().length > 0 ? body.diff : `${activePath} is identical in version ${version}.`);
    setPanel('diff');
  }

  async function rollback(version: number): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/versions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'rollback', version }),
      });
      const body = (await response.json()) as { error?: string; version?: { version: number } };
      if (!response.ok) {
        setStatus(body.error ?? 'The rollback failed.');
        return;
      }
      setStatus(`Rolled back to version ${version}, recorded as version ${body.version?.version}.`);
      await refreshVersions();
      if (activePath) await open(activePath);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ide">
      <aside className="ide-explorer">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files…"
          style={{ marginBottom: 8, padding: '6px 9px', fontSize: 13 }}
        />
        {filtered.length === 0 ? (
          <div className="faint" style={{ fontSize: 12.5, padding: 8 }}>
            {files.length === 0 ? 'This project has no indexed source files.' : 'No file matches that filter.'}
          </div>
        ) : (
          <Tree node={tree} depth={0} activePath={activePath} onOpen={(p) => void open(p)} />
        )}
      </aside>

      <section className="ide-editor">
        <div className="ide-toolbar">
          <span className="mono" style={{ fontSize: 12.5 }}>
            {activePath ?? 'no file open'}
            {dirty ? <span style={{ color: 'var(--warn)' }}> ● unsaved</span> : null}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {canWrite ? (
              <button
                data-variant="primary"
                disabled={!dirty || busy}
                onClick={() => void save()}
                style={{ fontSize: 12.5, padding: '5px 12px' }}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            ) : null}
            {dirty ? (
              <button onClick={() => setContent(original)} style={{ fontSize: 12.5, padding: '5px 12px' }}>
                Revert
              </button>
            ) : null}
          </div>
        </div>

        <textarea
          className="ide-code"
          value={content}
          spellCheck={false}
          readOnly={!canWrite}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />

        {status ? (
          <div className="notice" style={{ marginTop: 10 }}>
            {status}
          </div>
        ) : null}
      </section>

      <aside className="ide-panel">
        <div className="ide-tabs">
          {(['symbols', 'history', 'diff'] as const).map((tab) => (
            <button key={tab} className={panel === tab ? 'active' : ''} onClick={() => setPanel(tab)}>
              {tab}
            </button>
          ))}
        </div>

        {panel === 'symbols' ? (
          activeFile && activeFile.symbols.length > 0 ? (
            <div className="ide-list">
              {activeFile.symbols.map((symbol) => (
                <div key={`${symbol.name}-${symbol.line}`} className="ide-list-row">
                  <span className="mono">{symbol.name}</span>
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {symbol.kind} · L{symbol.line}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 12.5, padding: 8 }}>
              {activeFile ? 'No symbols were indexed for this file.' : 'Open a file to see its symbols.'}
            </div>
          )
        ) : null}

        {panel === 'history' ? (
          versions.length === 0 ? (
            <div className="faint" style={{ fontSize: 12.5, padding: 8 }}>No versions have been committed.</div>
          ) : (
            <div className="ide-list">
              {versions.map((version) => (
                <div key={version.version} className="ide-list-row" style={{ display: 'block' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span className="mono">v{version.version}</span>
                    <span className="faint mono" style={{ fontSize: 11 }}>{version.authorType}</span>
                  </div>
                  <div style={{ fontSize: 12.5, margin: '2px 0' }}>{version.label}</div>
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {version.diffStats.files} files +{version.diffStats.additions} −{version.diffStats.deletions} ·{' '}
                    {version.createdAt.replace('T', ' ').slice(0, 16)}
                  </div>
                  <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                    <button onClick={() => void showDiff(version.version)} style={{ fontSize: 11.5, padding: '3px 8px' }}>
                      Diff
                    </button>
                    {canWrite ? (
                      <button
                        disabled={busy}
                        onClick={() => void rollback(version.version)}
                        style={{ fontSize: 11.5, padding: '3px 8px' }}
                      >
                        Roll back
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}

        {panel === 'diff' ? (
          diff.trim().length === 0 ? (
            <div className="faint" style={{ fontSize: 12.5, padding: 8 }}>
              Save a change or pick a version to see a diff.
            </div>
          ) : (
            <pre className="log diff">
              {diff.split('\n').map((line, index) => (
                <span
                  key={index}
                  style={{
                    display: 'block',
                    color: line.startsWith('+') && !line.startsWith('+++')
                      ? 'var(--ok)'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'var(--danger)'
                        : line.startsWith('@@')
                          ? 'var(--info)'
                          : undefined,
                  }}
                >
                  {line}
                </span>
              ))}
            </pre>
          )
        ) : null}
      </aside>
    </div>
  );
}

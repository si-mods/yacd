import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionItem, fetchData } from '../../api/connections';
import prettyBytes from '../../misc/pretty-bytes';
import { useApiConfig } from '../../store/app';
import type { ClashAPIConfig } from '../../types';
import { ContentHeader } from '../ContentHeader';
import s from './Flow.module.scss';
import type { RoutingHandle, StageOpen } from './RoutingStage';
import { RoutingStage } from './RoutingStage';

const { useEffect, useMemo, useRef, useState } = React;

// how many flow rows to render (sorted by current total speed)
const MAX_ROWS = 60;
// connections slower than this are treated as idle for bar width
const IDLE_SPEED = 1024; // 1 KB/s

type Speeds = { down: number; up: number };

type Agg = Speeds & { conns: number };

type FlowRow = {
  id: string;
  host: string;
  source: string;
  rule: string;
  node: string;
  groups: string[];
  network: string;
  chains: string[];
  speeds: Speeds;
};

type FlowState = {
  total: Speeds;
  byNode: Array<[string, Agg]>;
  byGroup: Array<[string, Agg]>;
  rows: FlowRow[];
  qty: number;
};

const emptyState: FlowState = {
  total: { down: 0, up: 0 },
  byNode: [],
  byGroup: [],
  rows: [],
  qty: 0,
};

function buildState(
  items: ConnectionItem[],
  prevKv: Map<string, Speeds>,
): { state: FlowState; opened: StageOpen[]; closed: string[] } {
  const total: Speeds = { down: 0, up: 0 };
  const nodeAgg = new Map<string, Agg>();
  const groupAgg = new Map<string, Agg>();
  const rows: FlowRow[] = [];
  const opened: StageOpen[] = [];
  const seen = new Set<string>();
  for (const c of items) {
    const prev = prevKv.get(c.id);
    // chains[0] is the actual outbound node, the rest are the matched groups
    const [node = 'DIRECT', ...groups] = c.chains ?? [];
    if (!prev) opened.push({ id: c.id, src: c.metadata.sourceIP || 'DIRECT', node });
    const down = c.download - (prev ? prev.down : 0);
    const up = c.upload - (prev ? prev.up : 0);
    prevKv.set(c.id, { down: c.download, up: c.upload });
    seen.add(c.id);
    total.down += down;
    total.up += up;
    const na = nodeAgg.get(node);
    if (na) {
      na.down += down;
      na.up += up;
      na.conns += 1;
    } else {
      nodeAgg.set(node, { down, up, conns: 1 });
    }
    const group = groups[groups.length - 1];
    if (group) {
      const ga = groupAgg.get(group);
      if (ga) {
        ga.down += down;
        ga.up += up;
        ga.conns += 1;
      } else {
        groupAgg.set(group, { down, up, conns: 1 });
      }
    }
    const { host, destinationIP, sourceIP, sourcePort, destinationPort } = c.metadata;
    rows.push({
      id: c.id,
      host: host || destinationIP || destinationPort,
      source: `${sourceIP}:${sourcePort}`,
      rule: c.rulePayload ? `${c.rule}(${c.rulePayload})` : c.rule,
      node,
      groups: groups.reverse(),
      network: c.metadata.network,
      chains: c.chains ?? [],
      speeds: { down, up },
    });
  }
  rows.sort((a, b) => b.speeds.down + b.speeds.up - (a.speeds.down + a.speeds.up));
  const byNode = [...nodeAgg.entries()].sort((a, b) => b[1].down + b[1].up - (a[1].down + a[1].up));
  const byGroup = [...groupAgg.entries()].sort(
    (a, b) => b[1].down + b[1].up - (a[1].down + a[1].up),
  );
  const closed: string[] = [];
  for (const id of [...prevKv.keys()]) {
    if (!seen.has(id)) {
      closed.push(id);
      prevKv.delete(id);
    }
  }
  return {
    state: { total, byNode, byGroup, rows: rows.slice(0, MAX_ROWS), qty: items.length },
    opened,
    closed,
  };
}

type QuotaInfo = {
  node: string;
  used: number;
  quota: number;
  remaining: number;
  pct: number;
  cycle_start: string;
  next_reset: string;
  max_reset_frac: number;
  purchasable: number;
};

function useQuota(apiConfig: ClashAPIConfig): QuotaInfo | null {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => {
      fetch('http://100.102.98.62:8765/')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!dead && d) setQuota(d);
        })
        .catch(() => {
          /* endpoint down; keep last value */
        });
    };
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [apiConfig]);
  return quota;
}

// --- Linode monthly transfer quota ---

const LINODE_TOKEN_KEY = 'yacd.linode.pat';

type LinodeTransfer = {
  used: number;
  quota: number;
  billing_cycle: string;
};

// account-level transfer; all values GB (docs: "in Gigabytes")
async function fetchLinodeTransfer(token: string): Promise<LinodeTransfer | null> {
  try {
    const r = await fetch('https://api.linode.com/v4/account/transfer', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      used: d.used * 1073741824,
      quota: d.quota * 1073741824,
      billing_cycle: '',
    };
  } catch {
    return null;
  }
}

type LinodeQuota = {
  used: number;
  quota: number;
  pct: number;
  remaining: number;
  cycle: string;
};

function useLinodeQuota(): {
  quota: LinodeQuota | null;
  token: string;
  setToken: (t: string) => void;
} {
  const [token, setTok] = useState(() => {
    try {
      return localStorage.getItem(LINODE_TOKEN_KEY) || '';
    } catch {
      return '';
    }
  });
  const [quota, setQuota] = useState<LinodeQuota | null>(null);
  useEffect(() => {
    if (!token) {
      setQuota(null);
      return;
    }
    let dead = false;
    const load = () =>
      fetchLinodeTransfer(token).then((d) => {
        if (!dead && d) {
          setQuota({
            used: d.used,
            quota: d.quota,
            pct: d.quota > 0 ? Math.round((d.used / d.quota) * 100) : 0,
            remaining: Math.max(0, d.quota - d.used),
            cycle: d.billing_cycle,
          });
        }
      });
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [token]);
  const setToken = (t: string) => {
    try {
      if (t) localStorage.setItem(LINODE_TOKEN_KEY, t);
      else localStorage.removeItem(LINODE_TOKEN_KEY);
    } catch {
      // ignore
    }
    setTok(t);
  };
  return { quota, token, setToken };
}

function LinodeQuotaCard({
  quota,
  token,
  setToken,
}: {
  quota: LinodeQuota | null;
  token: string;
  setToken: (t: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  if (!token) {
    return (
      <div className={`${s.statCard} ${s.quotaCard}`}>
        <div className={s.statLabel}>{t('Linode Monthly Transfer')}</div>
        <input
          className={s.quotaTokenInput}
          type="password"
          placeholder={t('Linode PAT') as string}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) setToken(draft.trim());
          }}
        />
        <div className={s.quotaMeta}>{t('linode_pat_hint')}</div>
      </div>
    );
  }
  if (!quota) return null;
  const warn = quota.pct >= 80;
  return (
    <div className={`${s.statCard} ${s.quotaCard}`}>
      <div className={s.statLabel}>
        {t('Linode Monthly Transfer')} · {quota.cycle}
      </div>
      <Speed v={quota.used} suffix={' / ' + prettyBytes(quota.quota)} />
      <div className={s.quotaBarTrack}>
        <div
          className={`${s.quotaBar} ${warn ? s.quotaBarWarn : ''}`}
          style={{ width: `${Math.min(quota.pct, 100)}%` }}
        />
      </div>
      <div className={s.quotaMeta}>
        <span>
          {quota.pct}% · {t('Remaining')} {prettyBytes(quota.remaining)}
        </span>
        <button
          type="button"
          className={s.quotaTokenClear}
          title={t('linode_pat_clear') as string}
          onClick={() => setToken('')}
        >
          {t('linode_pat_clear')}
        </button>
      </div>
    </div>
  );
}

function QuotaCard({ quota }: { quota: QuotaInfo }) {
  const { t } = useTranslation();
  const warn = quota.pct >= 80;
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(quota.next_reset).getTime() - Date.now()) / 86400000),
  );
  return (
    <div className={`${s.statCard} ${s.quotaCard}`}>
      <div className={s.statLabel}>
        {t('DMIT Monthly Transfer')} · {quota.cycle_start} → {quota.next_reset}
      </div>
      <Speed v={quota.used} suffix={' / ' + prettyBytes(quota.quota)} />
      <div className={s.quotaBarTrack}>
        <div
          className={`${s.quotaBar} ${warn ? s.quotaBarWarn : ''}`}
          style={{ width: `${Math.min(quota.pct, 100)}%` }}
        />
      </div>
      <div className={s.quotaMeta}>
        <span>
          {quota.pct}% · {t('Remaining')} {prettyBytes(quota.remaining)}
        </span>
        <span>
          {t('Resets in')} {daysLeft} {t('days')} · {quota.node}
        </span>
      </div>
      {quota.purchasable > 0 && quota.pct >= 70 && (
        <div className={`${s.quotaMeta} ${s.quotaResetHint}`}>
          <span>
            ⚡ {t('Paid reset up to')} +{prettyBytes(quota.purchasable)}
          </span>
        </div>
      )}
    </div>
  );
}

function Speed({ v, suffix = '/s' }: { v: number; suffix?: string }) {
  return (
    <span className={s.statValue}>
      {prettyBytes(v)}
      <span className={s.statUnit}>{suffix}</span>
    </span>
  );
}

function NodeRank({ entries, max }: { entries: Array<[string, Agg]>; max: number }) {
  const { t } = useTranslation();
  return (
    <div className={s.section}>
      <div className={s.sectionTitle}>{t('Outbound Nodes')}</div>
      <div className={s.nodeRank}>
        {entries.slice(0, 8).map(([name, agg]) => (
          <div className={s.nodeRow} key={name}>
            <div className={s.nodeName} title={name}>
              {name}
              <span className={s.groupChipSpeed}> · {agg.conns}</span>
            </div>
            <div className={s.nodeBarTrack}>
              <div
                className={s.nodeBar}
                style={{ width: `${max > 0 ? Math.max((agg.down / max) * 100, 1) : 0}%` }}
              />
            </div>
            <div className={s.nodeSpeed}>{prettyBytes(agg.down)}/s</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupChips({ entries }: { entries: Array<[string, Agg]> }) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div className={s.section}>
      <div className={s.sectionTitle}>{t('Proxy Groups')}</div>
      <div className={s.groupChips}>
        {entries.map(([name, agg]) => (
          <span className={s.groupChip} key={name}>
            {name}
            <span className={s.groupChipSpeed}>
              ↓{prettyBytes(agg.down)}/s ↑{prettyBytes(agg.up)}/s
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

type GroupMode = '' | 'rule' | 'chains' | 'node' | 'host';

// metacubexd-style groupable columns: key extractor per mode
function groupKeyOf(row: FlowRow, mode: GroupMode): string {
  switch (mode) {
    case 'rule':
      return row.rule;
    case 'chains':
      // full chain path, e.g. "Google > 🇭🇰 HK > HK 12"
      return row.chains.length > 0 ? [...row.chains].reverse().join(' → ') : 'DIRECT';
    case 'node':
      return row.node;
    case 'host':
      return row.host.split(':')[0] || row.host;
    default:
      return '';
  }
}

type FlowGroup = { key: string; rows: FlowRow[]; agg: Agg };

function buildGroups(rows: FlowRow[], mode: GroupMode): FlowGroup[] {
  const map = new Map<string, FlowGroup>();
  for (const r of rows) {
    const key = groupKeyOf(r, mode);
    let g = map.get(key);
    if (!g) {
      g = { key, rows: [], agg: { down: 0, up: 0, conns: 0 } };
      map.set(key, g);
    }
    g.rows.push(r);
    g.agg.down += r.speeds.down;
    g.agg.up += r.speeds.up;
    g.agg.conns += 1;
  }
  return [...map.values()].sort((a, b) => b.agg.down + b.agg.up - (a.agg.down + a.agg.up));
}

function FlowRowView({ row, maxSpeed }: { row: FlowRow; maxSpeed: number }) {
  const speed = row.speeds.down + row.speeds.up;
  const pct = maxSpeed > 0 && speed > IDLE_SPEED ? (speed / maxSpeed) * 100 : 0;
  return (
    <div className={s.flowRow}>
      <div className={s.flowEndpoint}>
        <div className={s.flowHost} title={row.host}>
          {row.network === 'udp' ? '↯ ' : ''}
          {row.host}
        </div>
        <div className={s.flowSource}>{row.source}</div>
      </div>
      <div className={s.ruleText} title={row.rule}>
        {row.rule}
      </div>
      <div className={s.chainChips}>
        {row.groups.map((g) => (
          <React.Fragment key={g}>
            <span className={s.chainChip}>{g}</span>
            <span className={s.chainArrow}>→</span>
          </React.Fragment>
        ))}
        <span className={`${s.chainChip} ${s.chainChipNode}`}>{row.node}</span>
      </div>
      <div className={s.flowSpeedCol}>
        <div className={s.flowSpeedNums}>
          <span>↓{prettyBytes(row.speeds.down)}/s</span>
          <span>↑{prettyBytes(row.speeds.up)}/s</span>
        </div>
        <div className={s.flowBarTrack}>
          <div className={s.flowBar} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function Flow() {
  const apiConfig = useApiConfig();
  const [state, setState] = useState<FlowState>(emptyState);
  const prevTotalsRef = useRef(new Map<string, Speeds>());
  const lastTickRef = useRef(0);
  const [groupMode, setGroupMode] = useState<GroupMode>('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const quota = useQuota(apiConfig);
  const linode = useLinodeQuota();
  const stageRef = useRef<RoutingHandle>(null);

  const read = React.useCallback(({ connections }: { connections: ConnectionItem[] }) => {
    // the ws ticks fast; only rebuild at ~1Hz so the bars animate smoothly
    const now = Date.now();
    if (now - lastTickRef.current < 900) return;
    lastTickRef.current = now;
    const { state: next, opened, closed } = buildState(connections ?? [], prevTotalsRef.current);
    setState(next);
    stageRef.current?.push({ opened, closed });
    stageRef.current?.speeds(next.byNode.map(([n, a]) => [n, a.down] as [string, number]), next.qty);
  }, []);

  useEffect(() => {
    prevTotalsRef.current = new Map();
    return fetchData(apiConfig, read);
  }, [apiConfig, read]);

  const maxNodeDown = useMemo(
    () => Math.max(1, ...state.byNode.map(([, a]) => a.down)),
    [state.byNode],
  );
  const maxRowSpeed = useMemo(
    () => (state.rows.length > 0 ? state.rows[0].speeds.down + state.rows[0].speeds.up : 0),
    [state.rows],
  );
  const { t } = useTranslation();
  const modeLabels: Array<[GroupMode, string]> = [
    ['', t('group_none')],
    ['rule', t('group_by_rule')],
    ['chains', t('group_by_chains')],
    ['node', t('group_by_node')],
    ['host', t('group_by_host')],
  ];
  const groups = useMemo(
    () => (groupMode ? buildGroups(state.rows, groupMode) : []),
    [state.rows, groupMode],
  );

  const switchMode = (m: GroupMode) => {
    setGroupMode(m);
    setExpanded({});
  };
  const toggleGroup = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className={s.flow}>
      <ContentHeader title={t('Flow')} />
      <div className={s.statRow}>
        <div className={s.statCard}>
          <div className={s.statLabel}>{t('Download')}</div>
          <Speed v={state.total.down} />
        </div>
        <div className={s.statCard}>
          <div className={s.statLabel}>{t('Upload')}</div>
          <Speed v={state.total.up} />
        </div>
        <div className={s.statCard}>
          <div className={s.statLabel}>{t('Active Connections')}</div>
          <Speed v={state.qty} suffix="" />
        </div>
        {quota && <QuotaCard quota={quota} />}
        <LinodeQuotaCard quota={linode.quota} token={linode.token} setToken={linode.setToken} />
      </div>
      <div className={s.section}>
        <div className={s.sectionTitle}>{t('Routing')}</div>
        <RoutingStage ref={stageRef} backend={apiConfig.baseURL} />
      </div>
      <NodeRank entries={state.byNode} max={maxNodeDown} />
      <GroupChips entries={state.byGroup} />
      <div className={s.section}>
        <div className={s.sectionTitle}>
          {t('Active Flows')}
          <span className={s.groupToolbar}>
            {modeLabels.map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`${s.groupModeBtn} ${groupMode === m ? s.groupModeBtnActive : ''}`}
                onClick={() => switchMode(m)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        {state.rows.length === 0 ? (
          <div className={s.placeHolder}>{t('no_active_flows')}</div>
        ) : groupMode ? (
          <div className={s.flowList}>
            {groups.map((g) => {
              const isOpen = !!expanded[g.key];
              return (
                <React.Fragment key={g.key}>
                  <div
                    className={s.groupHeader}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(g.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(g.key);
                      }
                    }}
                  >
                    <span className={`${s.groupChevron} ${isOpen ? s.groupChevronOpen : ''}`}>
                      ▶
                    </span>
                    <span className={s.groupTitle} title={g.key}>
                      {g.key}
                    </span>
                    <span className={s.groupCount}>({g.agg.conns})</span>
                    <span className={s.groupAggSpeed}>
                      ↓{prettyBytes(g.agg.down)}/s ↑{prettyBytes(g.agg.up)}/s
                    </span>
                  </div>
                  {isOpen && (
                    <div className={s.groupChildren}>
                      {g.rows.map((row) => (
                        <FlowRowView key={row.id} row={row} maxSpeed={maxRowSpeed} />
                      ))}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <div className={s.flowList}>
            {state.rows.map((row) => (
              <FlowRowView key={row.id} row={row} maxSpeed={maxRowSpeed} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

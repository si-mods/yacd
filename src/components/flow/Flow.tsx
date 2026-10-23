import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionItem, fetchData } from '../../api/connections';
import prettyBytes from '../../misc/pretty-bytes';
import { useApiConfig } from '../../store/app';
import { ContentHeader } from '../ContentHeader';
import s from './Flow.module.scss';

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

function buildState(items: ConnectionItem[], prevKv: Map<string, Speeds>): FlowState {
  const total: Speeds = { down: 0, up: 0 };
  const nodeAgg = new Map<string, Agg>();
  const groupAgg = new Map<string, Agg>();
  const rows: FlowRow[] = [];
  for (const c of items) {
    const prev = prevKv.get(c.id);
    // chains[0] is the actual outbound node, the rest are the matched groups
    const [node = 'DIRECT', ...groups] = c.chains ?? [];
    const down = c.download - (prev ? prev.down : 0);
    const up = c.upload - (prev ? prev.up : 0);
    prevKv.set(c.id, { down: c.download, up: c.upload });
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
      speeds: { down, up },
    });
  }
  rows.sort((a, b) => b.speeds.down + b.speeds.up - (a.speeds.down + a.speeds.up));
  const byNode = [...nodeAgg.entries()].sort((a, b) => b[1].down + b[1].up - (a[1].down + a[1].up));
  const byGroup = [...groupAgg.entries()].sort(
    (a, b) => b[1].down + b[1].up - (a[1].down + a[1].up),
  );
  return { total, byNode, byGroup, rows: rows.slice(0, MAX_ROWS), qty: items.length };
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

  const read = React.useCallback(({ connections }: { connections: ConnectionItem[] }) => {
    // the ws ticks fast; only rebuild at ~1Hz so the bars animate smoothly
    const now = Date.now();
    if (now - lastTickRef.current < 900) return;
    lastTickRef.current = now;
    setState(buildState(connections ?? [], prevTotalsRef.current));
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
      </div>
      <NodeRank entries={state.byNode} max={maxNodeDown} />
      <GroupChips entries={state.byGroup} />
      <div className={s.section}>
        <div className={s.sectionTitle}>{t('Active Flows')}</div>
        {state.rows.length === 0 ? (
          <div className={s.placeHolder}>{t('no_active_flows')}</div>
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

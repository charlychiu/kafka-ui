import React from 'react';
import * as Metrics from 'components/common/Metrics';
import Table from 'components/common/NewTable';
import { ColumnDef } from '@tanstack/react-table';
import useAppParams from 'lib/hooks/useAppParams';
import { ClusterName } from 'redux/interfaces';
import { useMetadataQuorum } from 'lib/hooks/api/brokers';
import { MetadataQuorumReplica } from 'generated-sources';
import { formatTimestamp } from 'lib/dateTimeHelpers';

type QuorumRow = MetadataQuorumReplica & { role: string };

// KRaft controller quorum panel. Surfaces the metadata quorum returned by
// describeMetadataQuorum() — including dedicated controllers that are NOT part of
// the broker node list. Renders nothing on ZooKeeper clusters (endpoint 404s).
const KraftQuorum: React.FC = () => {
  const { clusterName } = useAppParams<{ clusterName: ClusterName }>();
  const { data } = useMetadataQuorum(clusterName);

  const rows = React.useMemo<QuorumRow[]>(() => {
    if (!data) return [];
    return [
      ...(data.voters ?? []).map((r) => ({ ...r, role: 'voter' })),
      ...(data.observers ?? []).map((r) => ({ ...r, role: 'observer' })),
    ];
  }, [data]);

  const columns = React.useMemo<ColumnDef<QuorumRow>[]>(
    () => [
      {
        header: 'Replica ID',
        accessorKey: 'replicaId',
        cell: ({ getValue, row }) =>
          `${getValue<number>()}${row.original.leader ? ' ★' : ''}`,
      },
      { header: 'Role', accessorKey: 'role' },
      {
        header: 'Log end offset',
        accessorKey: 'logEndOffset',
        cell: ({ getValue }) => getValue<number>()?.toLocaleString() ?? '-',
      },
      {
        header: 'Lag',
        accessorKey: 'lag',
        cell: ({ getValue }) => getValue<number>()?.toLocaleString() ?? '-',
      },
      {
        header: 'Last caught up',
        accessorKey: 'lastCaughtUpTimestamp',
        cell: ({ getValue }) => formatTimestamp(getValue<number>()) || '-',
      },
    ],
    []
  );

  if (!data) {
    return null;
  }

  return (
    <>
      <Metrics.Wrapper>
        <Metrics.Section title="Controller quorum (KRaft)">
          <Metrics.Indicator label="Leader">{data.leaderId}</Metrics.Indicator>
          <Metrics.Indicator label="Leader epoch">
            {data.leaderEpoch}
          </Metrics.Indicator>
          <Metrics.Indicator label="High watermark">
            {data.highWatermark?.toLocaleString()}
          </Metrics.Indicator>
        </Metrics.Section>
      </Metrics.Wrapper>
      <Table columns={columns} data={rows} enableSorting />
    </>
  );
};

export default KraftQuorum;

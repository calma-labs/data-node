'use strict';

// Run once to provision the BigQuery tables:
//   node create-table.js

const { BigQuery } = require('@google-cloud/bigquery');
const { GoogleAuth, Impersonated } = require('google-auth-library');

const PROJECT = 'calmal';
const DATASET = 'lending_poc';
const SA      = process.env.IMPERSONATE_SA || 'lending-poc@calmal.iam.gserviceaccount.com';

const POOL_SCHEMA = [
  { name: 'id',            type: 'INT64',  mode: 'REQUIRED' },
  { name: 'reservePubkey', type: 'STRING', mode: 'REQUIRED' },
  { name: 'symbol',        type: 'STRING', mode: 'REQUIRED' },
  { name: 'mintAddress',   type: 'STRING', mode: 'REQUIRED' },
  { name: 'lending',       type: 'STRING', mode: 'REQUIRED' },
  { name: 'chain',         type: 'STRING', mode: 'REQUIRED' },
  { name: 'market',        type: 'STRING', mode: 'REQUIRED' },
];

const SNAPSHOTS_SCHEMA = [
  { name: 'poolId',        type: 'INT64',     mode: 'REQUIRED' },
  { name: 'tvl',           type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'utilization',   type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'supplyAPY',     type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'borrowRate',    type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'borrowAPY',     type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'totalBorrowUsd',type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'liquidityUsd',  type: 'NUMERIC',   mode: 'REQUIRED' },
  { name: 'fetchedAt',     type: 'TIMESTAMP', mode: 'REQUIRED' },
];

(async () => {
  const base = new GoogleAuth();
  const sourceClient = await base.getClient();

  const impersonated = new Impersonated({
    sourceClient,
    targetPrincipal: SA,
    lifetime: 300,
    targetScopes: ['https://www.googleapis.com/auth/bigquery'],
  });

  const bq = new BigQuery({ projectId: PROJECT, authClient: impersonated });
  console.log(`[bq] impersonating ${SA}`);

  const ds = bq.dataset(DATASET);

  for (const name of ['pool', 'snapshots']) {
    const table = ds.table(name);
    const [exists] = await table.exists();
    if (exists) {
      await table.delete();
      console.log(`Deleted ${DATASET}.${name}`);
    }
  }

  const [pool]      = await ds.createTable('pool',      { schema: POOL_SCHEMA });
  const [snapshots] = await ds.createTable('snapshots', { schema: SNAPSHOTS_SCHEMA });

  console.log(`Created ${PROJECT}.${DATASET}.${pool.id}`);
  console.log(`Created ${PROJECT}.${DATASET}.${snapshots.id}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});

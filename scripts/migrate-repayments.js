const pool = require('../db');

const promisePool = pool.promise();

const REQUIRED_COLUMNS = [
  ['loan_id', 'INT DEFAULT NULL', 'user_id'],
  ['amount', 'DECIMAL(10,2) NOT NULL', 'loan_id'],
  ['payment_mode', "VARCHAR(100) DEFAULT 'M-Pesa'", 'amount'],
  ['account_number', 'VARCHAR(100) DEFAULT NULL', 'payment_mode'],
  ['receipt_number', 'VARCHAR(100) DEFAULT NULL', 'account_number'],
  ['provider_request_id', 'VARCHAR(100) DEFAULT NULL', 'receipt_number'],
  ['checkout_request_id', 'VARCHAR(100) DEFAULT NULL', 'provider_request_id'],
  ['failure_reason', 'VARCHAR(255) DEFAULT NULL', 'checkout_request_id'],
  ['status', "VARCHAR(50) DEFAULT 'Pending'", 'failure_reason'],
  ['completed_at', 'DATETIME DEFAULT NULL', 'status'],
  ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', 'completed_at']
];

const createRepaymentsTable = async () => {
  await promisePool.query(`
    CREATE TABLE IF NOT EXISTS repayments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      loan_id INT DEFAULT NULL,
      amount DECIMAL(10,2) NOT NULL,
      payment_mode VARCHAR(100) DEFAULT 'M-Pesa',
      account_number VARCHAR(100) DEFAULT NULL,
      receipt_number VARCHAR(100) DEFAULT NULL,
      provider_request_id VARCHAR(100) DEFAULT NULL,
      checkout_request_id VARCHAR(100) DEFAULT NULL,
      failure_reason VARCHAR(255) DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      completed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const getExistingColumns = async () => {
  const [rows] = await promisePool.query('SHOW COLUMNS FROM repayments');
  return new Set(rows.map((row) => row.Field));
};

const addMissingColumn = async (column, definition, afterColumn, existingColumns) => {
  if (existingColumns.has(column)) {
    console.log(`repayments.${column} already exists`);
    return;
  }

  const afterClause = afterColumn && existingColumns.has(afterColumn) ? ` AFTER ${afterColumn}` : '';
  await promisePool.query(`ALTER TABLE repayments ADD COLUMN ${column} ${definition}${afterClause}`);
  existingColumns.add(column);
  console.log(`Added repayments.${column}`);
};

const migrate = async () => {
  try {
    await promisePool.query('SELECT 1');
    await createRepaymentsTable();

    const existingColumns = await getExistingColumns();
    for (const [column, definition, afterColumn] of REQUIRED_COLUMNS) {
      await addMissingColumn(column, definition, afterColumn, existingColumns);
    }

    console.log('Repayments schema is aligned.');
  } finally {
    await promisePool.end();
  }
};

migrate().catch((error) => {
  console.error('Repayments migration failed:', error.message);
  process.exitCode = 1;
});

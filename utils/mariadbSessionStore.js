const session = require('express-session');

class MariaDbSessionStore extends session.Store {
  constructor(pool, options = {}) {
    super();
    this.pool = pool;
    this.tableName = options.tableName || 'app_sessions';
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;
  }

  async ready() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        sid VARCHAR(128) PRIMARY KEY,
        sess LONGTEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_app_sessions_expires_at (expires_at)
      ) ENGINE=InnoDB
    `);
    await this.pool.query(`DELETE FROM ${this.tableName} WHERE expires_at <= NOW()`);
  }

  get(sid, callback) {
    this.pool.query(
      `SELECT sess FROM ${this.tableName} WHERE sid = ? AND expires_at > NOW() LIMIT 1`,
      [sid]
    ).then((rows) => {
      if (!rows.length) return callback(null, null);
      try {
        return callback(null, JSON.parse(rows[0].sess));
      } catch (err) {
        return callback(err);
      }
    }).catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    let expiresAt = new Date(Date.now() + this.ttlMs);
    if (sess.cookie && sess.cookie.expires) {
      expiresAt = new Date(sess.cookie.expires);
    }

    this.pool.query(
      `INSERT INTO ${this.tableName} (sid, sess, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE sess = VALUES(sess), expires_at = VALUES(expires_at)`,
      [sid, JSON.stringify(sess), expiresAt]
    ).then(() => callback()).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.pool.query(
      `DELETE FROM ${this.tableName} WHERE sid = ?`,
      [sid]
    ).then(() => callback()).catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    let expiresAt = new Date(Date.now() + this.ttlMs);
    if (sess.cookie && sess.cookie.expires) {
      expiresAt = new Date(sess.cookie.expires);
    }

    this.pool.query(
      `UPDATE ${this.tableName} SET expires_at = ? WHERE sid = ?`,
      [expiresAt, sid]
    ).then(() => callback()).catch(callback);
  }

  clearExpired(callback = () => {}) {
    this.pool.query(
      `DELETE FROM ${this.tableName} WHERE expires_at <= NOW()`
    ).then(() => callback()).catch(callback);
  }
}

module.exports = MariaDbSessionStore;

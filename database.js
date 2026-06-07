const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Railway Volume 배포 시: 환경변수 DB_PATH를 '/data/ranking.db'로 설정
// 로컬 실행 시: 기본값으로 프로젝트 폴더의 ranking.db 사용
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ranking.db');
let dbInstance = null;

/**
 * DB 저장 (메모리 → 파일)
 */
function saveDB() {
  if (dbInstance) {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

/**
 * DB 초기화 (비동기)
 */
async function initDB() {
  const SQL = await initSqlJs();

  // 기존 DB 파일이 있으면 로드 (0바이트이거나 손상된 경우 새로 생성)
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    if (fileBuffer.length > 0) {
      try {
        dbInstance = new SQL.Database(fileBuffer);
      } catch (e) {
        console.log('[DB] 기존 DB 손상됨, 새로 생성합니다:', e.message);
        dbInstance = new SQL.Database();
      }
    } else {
      dbInstance = new SQL.Database();
    }
  } else {
    dbInstance = new SQL.Database();
  }

  // 테이블 생성
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      product_url TEXT,
      thumbnail_url TEXT,
      price INTEGER DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      store_name TEXT DEFAULT '가시제거연구소',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      is_auto_extracted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS rankings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword_id INTEGER NOT NULL,
      rank_position INTEGER,
      page_number INTEGER DEFAULT 1,
      total_results INTEGER,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_catalog INTEGER DEFAULT 0,
      FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
    )
  `);

  // is_catalog 컬럼 마이그레이션 (기존 DB 호환)
  try { dbInstance.run('ALTER TABLE rankings ADD COLUMN is_catalog INTEGER DEFAULT 0'); } catch(e) {}

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS alert_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 1,
      rank_drop_threshold INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 기본 알림 설정
  const alertCount = dbInstance.exec('SELECT COUNT(*) as cnt FROM alert_settings');
  if (alertCount[0].values[0][0] === 0) {
    dbInstance.run(
      'INSERT INTO alert_settings (email, is_enabled, rank_drop_threshold) VALUES (?, ?, ?)',
      ['imteacherdana@gmail.com', 1, 5]
    );
  }

  // catalog_id 컬럼 추가 (기존 DB 마이그레이션)
  try { dbInstance.run('ALTER TABLE products ADD COLUMN catalog_id TEXT DEFAULT NULL'); } catch(e) { /* 이미 존재 */ }

  // FK 활성화
  dbInstance.run('PRAGMA foreign_keys = ON');

  saveDB();
  console.log('[DB] 데이터베이스 초기화 완료');
  return dbInstance;
}

/**
 * DB 인스턴스 가져오기
 */
function getDB() {
  if (!dbInstance) {
    throw new Error('DB가 아직 초기화되지 않았습니다. initDB()를 먼저 호출하세요.');
  }
  return dbInstance;
}

/**
 * sql.js 헬퍼: SELECT 결과를 객체 배열로 변환
 */
function queryAll(sql, params = []) {
  const db = getDB();
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * sql.js 헬퍼: 단일 행 조회
 */
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * sql.js 헬퍼: INSERT/UPDATE/DELETE 실행
 */
function run(sql, params = []) {
  const db = getDB();
  db.run(sql, params);
  // last_insert_rowid()는 run 직후에 바로 호출해야 정확한 값을 반환
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const lastId = stmt.getAsObject().id || 0;
  stmt.free();
  const changes = db.getRowsModified();
  saveDB();
  return {
    lastInsertRowid: lastId,
    changes: changes,
  };
}

module.exports = { initDB, getDB, saveDB, queryAll, queryOne, run, DB_PATH };

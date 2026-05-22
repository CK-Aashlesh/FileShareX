const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'database');
const SQLITE_PATH = path.join(DB_DIR, 'chat.db');
const JSON_PATH = path.join(DB_DIR, 'chat.json');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance = null;
let useJsonFallback = false;
let jsonDbData = [];

// SQLite implementation
class SQLiteDB {
  constructor() {
    this.sqlite3 = require('sqlite3').verbose();
    this.db = null;
  }

  init() {
    return new Promise((resolve, reject) => {
      this.db = new this.sqlite3.Database(SQLITE_PATH, (err) => {
        if (err) return reject(err);

        const createTableQuery = `
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            message TEXT,
            type TEXT NOT NULL,
            fileUrl TEXT,
            fileName TEXT,
            fileSize INTEGER,
            fileType TEXT,
            timestamp INTEGER NOT NULL,
            channel TEXT NOT NULL
          )
        `;

        this.db.run(createTableQuery, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  saveMessage(msg) {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO messages (username, message, type, fileUrl, fileName, fileSize, fileType, timestamp, channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      this.db.run(
        query,
        [
          msg.username,
          msg.message || null,
          msg.type,
          msg.fileUrl || null,
          msg.fileName || null,
          msg.fileSize || null,
          msg.fileType || null,
          msg.timestamp,
          msg.channel
        ],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID, ...msg });
        }
      );
    });
  }

  getMessages(channel, limit = 100) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM messages 
        WHERE channel = ? 
        ORDER BY timestamp ASC 
        LIMIT ?
      `;
      this.db.all(query, [channel, limit], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  searchMessages(channel, searchTerm) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM messages 
        WHERE channel = ? AND (message LIKE ? OR fileName LIKE ?)
        ORDER BY timestamp ASC
      `;
      const likeTerm = `%${searchTerm}%`;
      this.db.all(query, [channel, likeTerm, likeTerm], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  getMessageById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM messages WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  deleteMessage(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM messages WHERE id = ?', [id], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

// JSON Fallback implementation (extremely robust, doesn't require native modules)
const jsonDB = {
  init() {
    return new Promise((resolve) => {
      try {
        if (fs.existsSync(JSON_PATH)) {
          const raw = fs.readFileSync(JSON_PATH, 'utf8');
          jsonDbData = JSON.parse(raw);
        } else {
          jsonDbData = [];
          fs.writeFileSync(JSON_PATH, JSON.stringify(jsonDbData, null, 2), 'utf8');
        }
      } catch (err) {
        console.error('Error loading JSON database, resetting database in-memory:', err);
        jsonDbData = [];
      }
      resolve();
    });
  },

  saveMessage(msg) {
    return new Promise((resolve, reject) => {
      const newMsg = {
        id: jsonDbData.length + 1,
        ...msg
      };
      jsonDbData.push(newMsg);

      // Write atomically to avoid corruption
      try {
        const tempPath = JSON_PATH + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(jsonDbData, null, 2), 'utf8');
        fs.renameSync(tempPath, JSON_PATH);
        resolve(newMsg);
      } catch (err) {
        reject(err);
      }
    });
  },

  getMessages(channel, limit = 100) {
    return new Promise((resolve) => {
      const filtered = jsonDbData
        .filter((msg) => msg.channel === channel)
        .slice(-limit);
      resolve(filtered);
    });
  },

  searchMessages(channel, searchTerm) {
    return new Promise((resolve) => {
      const lowerSearch = searchTerm.toLowerCase();
      const filtered = jsonDbData.filter((msg) => {
        if (msg.channel !== channel) return false;
        const msgMatch = msg.message && msg.message.toLowerCase().includes(lowerSearch);
        const fileMatch = msg.fileName && msg.fileName.toLowerCase().includes(lowerSearch);
        return msgMatch || fileMatch;
      });
      resolve(filtered);
    });
  },

  getMessageById(id) {
    return new Promise((resolve) => {
      resolve(jsonDbData.find(m => m.id == id) || null);
    });
  },

  deleteMessage(id) {
    return new Promise((resolve, reject) => {
      const idx = jsonDbData.findIndex(m => m.id == id);
      if (idx !== -1) jsonDbData.splice(idx, 1);
      try {
        const tempPath = JSON_PATH + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(jsonDbData, null, 2), 'utf8');
        fs.renameSync(tempPath, JSON_PATH);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
};

// Main Export Interface
module.exports = {
  async init() {
    try {
      console.log('Attempting to initialize SQLite database...');
      dbInstance = new SQLiteDB();
      await dbInstance.init();
      console.log('SQLite database initialized successfully at:', SQLITE_PATH);
    } catch (err) {
      console.warn('SQLite initialization failed. Falling back to robust JSON-file database.');
      console.warn('Reason:', err.message);
      useJsonFallback = true;
      dbInstance = jsonDB;
      await dbInstance.init();
      console.log('JSON database initialized successfully at:', JSON_PATH);
    }
  },

  async saveMessage(msg) {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance.saveMessage(msg);
  },

  async getMessages(channel, limit = 100) {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance.getMessages(channel, limit);
  },

  async searchMessages(channel, searchTerm) {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance.searchMessages(channel, searchTerm);
  },

  async getMessageById(id) {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance.getMessageById(id);
  },

  async deleteMessage(id) {
    if (!dbInstance) throw new Error('Database not initialized');
    return dbInstance.deleteMessage(id);
  }
};

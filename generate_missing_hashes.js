const fs = require('fs');
const path = require('path');
const pool = require('./config/database');
const { generateHash } = require('./utils/imageHash');

(async () => {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log('Fetching registrations with photos...');
    const registrations = await conn.query(
      "SELECT id, motorcycle_photo, plate_photo FROM registrations WHERE motorcycle_photo IS NOT NULL OR plate_photo IS NOT NULL"
    );
    
    console.log(`Found ${registrations.length} registrations with photos. Checking missing hashes...`);
    
    let addedCount = 0;
    
    for (const reg of registrations) {
      // Check existing hashes for this registration
      const existing = await conn.query('SELECT image_type FROM image_hashes WHERE registration_id = ?', [reg.id]);
      const existingTypes = existing.map(e => e.image_type);
      
      // Process motorcycle photo
      if (reg.motorcycle_photo && !existingTypes.includes('motorcycle')) {
        const fullPath = path.join(__dirname, 'public', reg.motorcycle_photo);
        if (fs.existsSync(fullPath)) {
          console.log(`Generating hash for REG#${reg.id} - motorcycle`);
          const hash = await generateHash(fullPath);
          if (hash) {
            await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
              [reg.id, 'motorcycle', hash, reg.motorcycle_photo]);
            addedCount++;
          }
        }
      }
      
      // Process plate photo
      if (reg.plate_photo && !existingTypes.includes('plate')) {
        const fullPath = path.join(__dirname, 'public', reg.plate_photo);
        if (fs.existsSync(fullPath)) {
          console.log(`Generating hash for REG#${reg.id} - plate`);
          const hash = await generateHash(fullPath);
          if (hash) {
            await conn.query('INSERT INTO image_hashes (registration_id, image_type, phash, file_path) VALUES (?, ?, ?, ?)',
              [reg.id, 'plate', hash, reg.plate_photo]);
            addedCount++;
          }
        }
      }
    }
    
    console.log(`\n🎉 Success! Added ${addedCount} missing image hashes.`);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    if (conn) conn.release();
  }
})();

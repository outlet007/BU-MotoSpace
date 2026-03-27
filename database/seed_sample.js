const pool = require('../config/database');

const firstNames = ['สมชาย', 'สมหญิง', 'ประเสริฐ', 'มาลี', 'วิชัย', 'พรทิพย์', 'ศุภโชค', 'นารี', 'ณัฐวุฒิ', 'จิราพร', 'ธนพล', 'กิตติยา', 'เอกชัย', 'สุนิสา', 'วรุฒ', 'กัญญา'];
const lastNames = ['ใจดี', 'รักชาติ', 'หาญกล้า', 'บุญมา', 'มีทรัพย์', 'สุขประเสริฐ', 'วงษ์สุวรรณ', 'ทองดี', 'พิทักษ์', 'สมบูรณ์', 'ชัยชนะ', 'รุ่งเรือง', 'มณีรัตน์', 'เจริญผล'];
const provinces = ['กรุงเทพมหานคร', 'ปทุมธานี', 'นนทบุรี', 'สมุทรปราการ', 'ชลบุรี', 'เชียงใหม่', 'ขอนแก่น', 'นครราชสีมา', 'อยุธยา', 'นครปฐม'];
const ruleIds = [1, 2, 3, 4, 5]; // Default seeded rules
const admins = [1]; // ID 1 is the default superadmin

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateLicensePlate() {
  const letters = 'กก ขข คค งง จจ ฉฉ ชช ฬฬ ออ ฮฮ 1กข 2กด 3กท 4กค 5กธ'.split(' ');
  const nums = randomNumber(1, 9999);
  return `${randomItem(letters)} ${nums}`;
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

async function seedData() {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log('Seeding 30 sample registrations...');

    const now = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(now.getMonth() - 6);

    const insertedIds = [];

    // Insert 30 registrations
    for (let i = 0; i < 30; i++) {
       const userType = Math.random() > 0.7 ? 'staff' : 'student';
       const statusChoices = ['approved', 'approved', 'approved', 'pending', 'rejected'];
       const status = randomItem(statusChoices);
       const fName = randomItem(firstNames);
       const lName = randomItem(lastNames);
       const phone = '08' + randomNumber(10000000, 99999999);
       const plate = generateLicensePlate();
       const province = randomItem(provinces);
       const regDate = randomDate(sixMonthsAgo, now);
       
       const idNum = userType === 'student' ? '16' + randomNumber(10000000, 99999999) : 'BU' + randomNumber(100, 999);
       const defaultPhoto = '/images/placeholder.jpg';

       try {
         const res = await conn.query(`
           INSERT INTO registrations (
             user_type, id_number, first_name, last_name, 
             phone, license_plate, province, status, registered_at,
             motorcycle_photo, plate_photo, id_card_photo
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         `, [userType, idNum, fName, lName, phone, plate, province, status, regDate, defaultPhoto, defaultPhoto, defaultPhoto]);

         // MariaDB driver returns insertId in the result object
         const insertId = res.insertId ? res.insertId : Number(res.insertId);
         
         if (status === 'approved') {
           insertedIds.push({ id: insertId, date: regDate });
         }
       } catch (err) {
         if (err.code === 'ER_DUP_ENTRY') {
            // Simply skip duplicates
            continue;
         }
         throw err;
       }
    }

    console.log('✅ Created 30 registrations');
    console.log('Seeding violations...');

    // Insert 15 violations for the approved vehicles
    for (let i = 0; i < 15; i++) {
        if (insertedIds.length === 0) break;
        const target = randomItem(insertedIds);
        const ruleId = randomItem(ruleIds);
        
        // Violation date must be AFTER registration date
        const vioDate = randomDate(target.date, now);

        await conn.query(`
          INSERT INTO violations (registration_id, rule_id, description, recorded_at, recorded_by)
          VALUES (?, ?, ?, ?, ?)
        `, [target.id, ruleId, 'ทำผิดกฎการจอดรถหรือขับขี่', vioDate, 1]);
    }

    console.log('✅ Created 15 violations');
    console.log('🎉 Seeding complete!');

  } catch (err) {
    console.error('Error seeding data:', err);
  } finally {
    if (conn) conn.release();
    process.exit(0);
  }
}

seedData();

/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.11.16-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: localhost    Database: bu_motospace
-- ------------------------------------------------------
-- Server version	10.11.16-MariaDB-ubu2204

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `admins`
--

DROP TABLE IF EXISTS `admins`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `admins` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `full_name` varchar(200) NOT NULL,
  `role` enum('officer','head','superadmin') NOT NULL DEFAULT 'officer',
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `email` varchar(200) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `admins`
--

LOCK TABLES `admins` WRITE;
/*!40000 ALTER TABLE `admins` DISABLE KEYS */;
INSERT INTO `admins` VALUES
(1,'admin','$2b$10$YCB0uRR4byDP8JrtkmbYF.4LpUxTPLVEbZGid6jauI3/21oGkM2JO','รักดี เข้มงวด','superadmin',1,'2026-03-27 02:39:06','2026-03-27 05:03:03',NULL,NULL),
(2,'outlet007','$2b$10$57J/XOuRrJdCC5NPS7RKM.3ZEAirn089B67/CPIRvlnkiUDxVd5Oy','อารักษ์ ยาจิตต์','superadmin',1,'2026-03-27 04:58:24','2026-04-22 04:39:56','arluck.y@bu.ac.th','0819043901'),
(3,'test','$2b$10$uczHecSHsJSyqqG9xNmHcuG37uuTCy2knHNuU98DWKOcyenlQ6P3.','ทดสแบ เจ้าหน้าที่','officer',1,'2026-04-22 01:52:03','2026-04-22 08:05:18','test@bu.ac.th','0812345678');
/*!40000 ALTER TABLE `admins` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `image_hashes`
--

DROP TABLE IF EXISTS `image_hashes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `image_hashes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `registration_id` int(11) NOT NULL,
  `image_type` enum('motorcycle','plate') NOT NULL,
  `phash` varchar(64) NOT NULL,
  `file_path` varchar(500) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `registration_id` (`registration_id`),
  KEY `idx_phash` (`phash`),
  CONSTRAINT `image_hashes_ibfk_1` FOREIGN KEY (`registration_id`) REFERENCES `registrations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `image_hashes`
--

LOCK TABLES `image_hashes` WRITE;
/*!40000 ALTER TABLE `image_hashes` DISABLE KEYS */;
/*!40000 ALTER TABLE `image_hashes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `registrations`
--

DROP TABLE IF EXISTS `registrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `registrations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_type` enum('student','staff') NOT NULL,
  `id_number` varchar(50) NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `license_plate` varchar(20) NOT NULL,
  `province` varchar(100) NOT NULL,
  `motorcycle_photo` varchar(500) DEFAULT NULL,
  `plate_photo` varchar(500) DEFAULT NULL,
  `id_card_photo` varchar(500) DEFAULT NULL,
  `status` enum('pending','approved','rejected') DEFAULT 'pending',
  `registered_at` timestamp NULL DEFAULT current_timestamp(),
  `approved_by` int(11) DEFAULT NULL,
  `approved_at` timestamp NULL DEFAULT NULL,
  `notes` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plate` (`license_plate`),
  KEY `idx_id_number` (`id_number`),
  KEY `idx_user_type` (`user_type`),
  KEY `idx_status` (`status`),
  KEY `approved_by` (`approved_by`),
  CONSTRAINT `registrations_ibfk_1` FOREIGN KEY (`approved_by`) REFERENCES `admins` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=61 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `registrations`
--

LOCK TABLES `registrations` WRITE;
/*!40000 ALTER TABLE `registrations` DISABLE KEYS */;
INSERT INTO `registrations` VALUES
(1,'student','1683073392','สมหญิง','พิทักษ์','0892493703','ฮฮ 2654','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-02-02 18:15:21',NULL,NULL,NULL),
(2,'student','1618293200','ณัฐวุฒิ','วงษ์สุวรรณ','0833207177','4กค 6897','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-09-30 00:15:30',NULL,NULL,NULL),
(3,'student','1679214645','กัญญา','รุ่งเรือง','0873517408','ชช 7001','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-17 04:40:42',NULL,NULL,NULL),
(4,'student','1672932750','กัญญา','ชัยชนะ','0866638179','ฮฮ 6422','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-01-31 03:06:09',NULL,NULL,NULL),
(5,'student','1619224514','ประเสริฐ','ชัยชนะ','0832065415','งง 7158','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-01-18 23:34:08',NULL,NULL,NULL),
(6,'student','1672151927','วิชัย','รุ่งเรือง','0882086828','5กธ 1607','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-10 10:56:38',NULL,NULL,NULL),
(7,'student','1616745770','วิชัย','สุขประเสริฐ','0863062464','ออ 453','ขอนแก่น','/uploads/motorcycles/1774605388901-258875786.jpg','/uploads/plates/1774605410078-522413807.jpg','/uploads/id-cards/1774605410080-426329692.jpg','approved','2026-03-14 05:40:39',2,'2026-03-27 09:57:32',NULL),
(8,'student','1695811179','กัญญา','ใจดี','0876673968','ขข 3083','กรุงเทพมหานคร','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-12-01 11:04:17',NULL,NULL,NULL),
(9,'student','1651259441','สุนิสา','รุ่งเรือง','0835117956','ฉฉ 6551','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-01-03 05:47:49',NULL,NULL,NULL),
(10,'staff','BU819','สุนิสา','บุญมา','0824918219','ชช 7647','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-02-16 02:22:19',NULL,NULL,NULL),
(11,'staff','BU127','กัญญา','สมบูรณ์','0827206848','ออ 635','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-12-10 01:33:19',NULL,NULL,NULL),
(12,'staff','BU111','เอกชัย','รักชาติ','0882429783','กก 6636','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-30 05:11:33',NULL,NULL,NULL),
(13,'student','1652409437','กิตติยา','มณีรัตน์','0853891176','2กด 827','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-18 15:51:35',NULL,NULL,NULL),
(14,'staff','BU943','พรทิพย์','สุขประเสริฐ','0844342053','5กธ 6706','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-26 03:54:48',NULL,NULL,NULL),
(15,'staff','BU246','จิราพร','พิทักษ์','0899775657','ขข 3442','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-01 21:28:55',NULL,NULL,NULL),
(16,'student','1661105011','นารี','ชัยชนะ','0890952504','จจ 6669','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-08 10:17:18',NULL,NULL,NULL),
(17,'staff','BU904','วิชัย','มณีรัตน์','0810984946','4กค 4067','กรุงเทพมหานคร','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-13 15:14:38',2,'2026-03-27 07:02:43',NULL),
(18,'student','1683289322','สุนิสา','มีทรัพย์','0817691144','ออ 2964','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-01-29 05:25:52',NULL,NULL,NULL),
(19,'student','1669594566','สมชาย','รุ่งเรือง','0839110106','3กท 9835','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-01-31 03:35:02',NULL,NULL,NULL),
(20,'staff','BU994','เอกชัย','บุญมา','0885683636','2กด 3575','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-23 19:18:32',NULL,NULL,NULL),
(21,'student','1667369749','สมหญิง','พิทักษ์','0868914776','ขข 8430','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-05 16:57:14',2,'2026-03-27 07:03:21',NULL),
(22,'student','1696608634','ธนพล','มีทรัพย์','0831909182','1กข 5789','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-12 08:28:21',NULL,NULL,NULL),
(23,'student','1620661822','ณัฐวุฒิ','สมบูรณ์','0889096336','5กธ 4730','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-12-30 20:46:01',NULL,NULL,NULL),
(24,'student','1695694922','สมหญิง','วงษ์สุวรรณ','0835887384','5กธ 8849','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-09-30 18:23:43',2,'2026-03-27 07:03:31',NULL),
(25,'staff','BU683','สมหญิง','พิทักษ์','0865152956','4กค 6093','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-28 13:48:39',NULL,NULL,NULL),
(26,'staff','BU106','จิราพร','วงษ์สุวรรณ','0842622117','1กข 4279','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-10-07 16:33:14',NULL,NULL,NULL),
(27,'student','1632207264','สมชาย','มณีรัตน์','0836324386','จจ 5434','อยุธยา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-22 01:54:20',NULL,NULL,NULL),
(28,'student','1637712271','จิราพร','บุญมา','0825545188','ฉฉ 8054','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-15 00:46:28',NULL,NULL,NULL),
(29,'staff','BU380','กิตติยา','สุขประเสริฐ','0834867796','1กข 976','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-25 16:23:43',2,'2026-03-27 07:01:14',NULL),
(30,'student','1678755858','ประเสริฐ','พิทักษ์','0846319736','2กด 8267','อยุธยา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-14 15:03:03',NULL,NULL,NULL),
(31,'student','1692961560','เอกชัย','บุญมา','0887196691','คค 4606','กรุงเทพมหานคร','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-08 05:51:04',NULL,NULL,NULL),
(32,'staff','BU863','วรุฒ','มณีรัตน์','0814212991','ฮฮ 1195','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-20 14:31:14',NULL,NULL,NULL),
(33,'staff','BU769','นารี','มีทรัพย์','0864831237','ขข 9776','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-18 10:22:11',NULL,NULL,NULL),
(34,'staff','BU461','กิตติยา','สุขประเสริฐ','0884467565','คค 566','อยุธยา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-20 00:47:56',NULL,NULL,NULL),
(35,'student','1656696015','มาลี','หาญกล้า','0880444634','กก 9013','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-30 02:16:22',NULL,NULL,NULL),
(36,'staff','BU617','กัญญา','บุญมา','0888850522','จจ 4259','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-24 13:06:17',NULL,NULL,NULL),
(37,'student','1659329786','สมหญิง','ใจดี','0818116373','ฬฬ 8117','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-01-20 11:59:15',NULL,NULL,NULL),
(38,'student','1696588617','สมชาย','เจริญผล','0845037616','ออ 6804','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-01-09 09:34:44',NULL,NULL,NULL),
(39,'student','1694604508','ประเสริฐ','วงษ์สุวรรณ','0872776768','3กท 7202','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-12-16 23:02:20',NULL,NULL,NULL),
(40,'student','1683024839','กิตติยา','ชัยชนะ','0889455352','3กท 9780','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-26 05:41:39',2,'2026-03-27 07:01:02',NULL),
(41,'student','1638170785','ศุภโชค','ใจดี','0897790091','1กข 3033','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-04 10:32:42',NULL,NULL,NULL),
(42,'staff','BU353','จิราพร','รุ่งเรือง','0832530557','งง 345','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-11 23:35:07',NULL,NULL,NULL),
(43,'student','1668729392','จิราพร','มณีรัตน์','0854657697','จจ 541','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-11-07 11:03:58',NULL,NULL,NULL),
(44,'staff','BU290','ศุภโชค','ใจดี','0838913410','ขข 9640','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-06 15:42:16',NULL,NULL,NULL),
(45,'staff','BU115','ประเสริฐ','บุญมา','0890186955','ฬฬ 7227','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-11-13 00:41:13',NULL,NULL,NULL),
(46,'staff','BU208','ประเสริฐ','มณีรัตน์','0817414653','ออ 105','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2026-03-10 20:27:18',NULL,NULL,NULL),
(47,'staff','BU541','สมชาย','รักชาติ','0834835167','ฉฉ 2390','ขอนแก่น','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-26 10:59:34',NULL,NULL,NULL),
(48,'student','1615012623','ณัฐวุฒิ','มณีรัตน์','0823027073','งง 5401','อยุธยา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-01-01 06:09:19',NULL,NULL,NULL),
(49,'student','1684284844','ศุภโชค','บุญมา','0897486328','ฉฉ 1165','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-03 20:11:00',NULL,NULL,NULL),
(50,'staff','BU346','วรุฒ','พิทักษ์','0822155485','คค 3237','กรุงเทพมหานคร','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-02-12 14:08:13',NULL,NULL,NULL),
(51,'staff','BU763','พรทิพย์','บุญมา','0866638027','4กค 4976','นนทบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-11-29 23:56:30',NULL,NULL,NULL),
(52,'student','1684495878','สมหญิง','หาญกล้า','0892118305','จจ 850','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-12-23 23:24:04',NULL,NULL,NULL),
(53,'student','1673748044','เอกชัย','บุญมา','0849531571','คค 894','เชียงใหม่','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-11-12 13:48:06',NULL,NULL,NULL),
(54,'student','1693149847','ประเสริฐ','มณีรัตน์','0825088326','2กด 2477','ปทุมธานี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-02-05 16:01:05',NULL,NULL,NULL),
(55,'student','1647949165','สุนิสา','สุขประเสริฐ','0874467280','4กค 3899','นครราชสีมา','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-11-04 03:24:13',NULL,NULL,NULL),
(56,'student','1693090482','มาลี','หาญกล้า','0892133090','3กท 3010','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-02-28 09:13:31',NULL,NULL,NULL),
(57,'student','1664579055','กิตติยา','รักชาติ','0840519278','จจ 2362','กรุงเทพมหานคร','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','pending','2025-10-24 17:55:32',NULL,NULL,NULL),
(58,'student','1614801372','กัญญา','หาญกล้า','0858281021','4กค 7704','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-11-11 01:15:41',NULL,NULL,NULL),
(59,'student','1662807009','ประเสริฐ','สุขประเสริฐ','0899083389','คค 5345','สมุทรปราการ','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2025-10-05 06:12:25',NULL,NULL,NULL),
(60,'staff','BU721','สุนิสา','รุ่งเรือง','0810729067','ฮฮ 5809','ชลบุรี','/images/placeholder.jpg','/images/placeholder.jpg','/images/placeholder.jpg','approved','2026-03-01 23:06:34',NULL,NULL,NULL);
/*!40000 ALTER TABLE `registrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `rules`
--

DROP TABLE IF EXISTS `rules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `rules` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `rule_name` varchar(200) NOT NULL,
  `description` text DEFAULT NULL,
  `max_violations` int(11) NOT NULL DEFAULT 3,
  `penalty` text DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `rules_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `admins` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `rules`
--

LOCK TABLES `rules` WRITE;
/*!40000 ALTER TABLE `rules` DISABLE KEYS */;
INSERT INTO `rules` VALUES
(1,'จอดรถในที่ห้ามจอด','จอดรถจักรยานยนต์ในพื้นที่ที่ไม่อนุญาต',3,'ตักเตือน / ระงับสิทธิ์การใช้ที่จอดรถ',1,NULL,'2026-03-27 02:43:02','2026-03-27 02:43:02'),
(2,'ขับรถเร็วเกินกำหนด','ขับขี่ด้วยความเร็วเกินกว่าที่กำหนดภายในมหาวิทยาลัย',2,'ตักเตือน / ระงับสิทธิ์การนำรถเข้า',1,NULL,'2026-03-27 02:43:02','2026-03-27 02:43:02'),
(3,'ไม่สวมหมวกกันน็อค','ขับขี่โดยไม่สวมหมวกกันน็อคภายในเขตมหาวิทยาลัย',3,'ตักเตือน / ปรับ',1,NULL,'2026-03-27 02:43:02','2026-03-27 02:43:02'),
(4,'ไม่ติดสติ๊กเกอร์ลงทะเบียน','นำรถเข้ามหาวิทยาลัยโดยไม่มีสติ๊กเกอร์ลงทะเบียน',1,'ระงับสิทธิ์ทันที',1,NULL,'2026-03-27 02:43:02','2026-03-27 02:43:02'),
(5,'แต่งรถผิดกฎหมาย','นำรถที่ดัดแปลงผิดกฎหมายเข้ามหาวิทยาลัย เช่น ท่อดัง',2,'ตักเตือน / ห้ามนำรถเข้า',1,NULL,'2026-03-27 02:43:02','2026-03-27 02:43:02');
/*!40000 ALTER TABLE `rules` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `violation_reports`
--

DROP TABLE IF EXISTS `violation_reports`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `violation_reports` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `registration_id` int(11) NOT NULL,
  `rule_id` int(11) NOT NULL,
  `description` text DEFAULT NULL,
  `evidence_photo` varchar(500) DEFAULT NULL,
  `reported_by` int(11) NOT NULL,
  `reported_at` timestamp NULL DEFAULT current_timestamp(),
  `status` enum('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  `reviewed_by` int(11) DEFAULT NULL,
  `reviewed_at` timestamp NULL DEFAULT NULL,
  `review_note` text DEFAULT NULL,
  `violation_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `rule_id` (`rule_id`),
  KEY `reported_by` (`reported_by`),
  KEY `reviewed_by` (`reviewed_by`),
  KEY `violation_id` (`violation_id`),
  KEY `idx_vr_registration` (`registration_id`),
  KEY `idx_vr_status` (`status`),
  CONSTRAINT `violation_reports_ibfk_1` FOREIGN KEY (`registration_id`) REFERENCES `registrations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `violation_reports_ibfk_2` FOREIGN KEY (`rule_id`) REFERENCES `rules` (`id`) ON DELETE CASCADE,
  CONSTRAINT `violation_reports_ibfk_3` FOREIGN KEY (`reported_by`) REFERENCES `admins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `violation_reports_ibfk_4` FOREIGN KEY (`reviewed_by`) REFERENCES `admins` (`id`) ON DELETE SET NULL,
  CONSTRAINT `violation_reports_ibfk_5` FOREIGN KEY (`violation_id`) REFERENCES `violations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `violation_reports`
--

LOCK TABLES `violation_reports` WRITE;
/*!40000 ALTER TABLE `violation_reports` DISABLE KEYS */;
INSERT INTO `violation_reports` VALUES
(1,20,1,'ทดสอบ 2026-04-22',NULL,2,'2026-04-22 04:22:57','confirmed',2,'2026-04-22 04:24:08',NULL,18),
(2,47,2,NULL,NULL,2,'2026-04-22 04:29:30','confirmed',2,'2026-04-22 05:01:58',NULL,19),
(3,47,5,'ทดสอบ เจ้าหน้าที่ 2026-04-22','/uploads/evidence/1776836374582-133570116.jpg',3,'2026-04-22 05:39:34','pending',NULL,NULL,NULL,NULL),
(4,40,2,'เร็วมาก','/uploads/evidence/1776836577129-137197007.jpg',3,'2026-04-22 05:42:57','pending',NULL,NULL,NULL,NULL),
(5,29,2,'ทดสอบ เจ้าหน้าที่ 2026-04-22','/uploads/evidence/1776837016012-99245990.jpg',3,'2026-04-22 05:50:16','pending',NULL,NULL,NULL,NULL),
(6,40,2,'ทดสอบ เจ้าหน้าที่ 2026-04-22','/uploads/evidence/1776837201238-736212429.jpg',3,'2026-04-22 05:53:21','pending',NULL,NULL,NULL,NULL);
/*!40000 ALTER TABLE `violation_reports` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `violations`
--

DROP TABLE IF EXISTS `violations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `violations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `registration_id` int(11) NOT NULL,
  `rule_id` int(11) NOT NULL,
  `description` text DEFAULT NULL,
  `evidence_photo` varchar(500) DEFAULT NULL,
  `recorded_by` int(11) NOT NULL,
  `recorded_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `recorded_by` (`recorded_by`),
  KEY `idx_registration` (`registration_id`),
  KEY `idx_rule` (`rule_id`),
  CONSTRAINT `violations_ibfk_1` FOREIGN KEY (`registration_id`) REFERENCES `registrations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `violations_ibfk_2` FOREIGN KEY (`rule_id`) REFERENCES `rules` (`id`) ON DELETE CASCADE,
  CONSTRAINT `violations_ibfk_3` FOREIGN KEY (`recorded_by`) REFERENCES `admins` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=20 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `violations`
--

LOCK TABLES `violations` WRITE;
/*!40000 ALTER TABLE `violations` DISABLE KEYS */;
INSERT INTO `violations` VALUES
(2,54,1,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-04 17:53:13'),
(3,49,1,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-21 18:35:06'),
(4,35,4,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2025-11-23 10:57:46'),
(5,34,3,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-09 03:12:29'),
(6,58,3,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2025-12-27 18:59:36'),
(7,33,1,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-24 18:08:41'),
(8,32,3,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-02-16 18:37:03'),
(9,41,2,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-02-17 08:13:16'),
(10,47,2,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-27 04:08:10'),
(11,31,3,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2025-11-05 13:27:30'),
(12,38,1,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-02-27 06:44:10'),
(13,33,4,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-02-16 06:06:09'),
(14,34,4,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-01-16 20:02:32'),
(15,56,1,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-24 10:14:32'),
(16,48,4,'ทำผิดกฎการจอดรถหรือขับขี่',NULL,1,'2026-03-22 01:38:47'),
(17,47,1,'ทดสอบ 2026-04-22',NULL,2,'2026-04-22 04:18:23'),
(18,20,1,'ทดสอบ 2026-04-22',NULL,2,'2026-04-22 04:24:08'),
(19,47,2,NULL,NULL,2,'2026-04-22 05:01:58');
/*!40000 ALTER TABLE `violations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'bu_motospace'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-04-23  7:29:37

-- =====================================================
-- BU MotoSpace - Performance Optimization Indexes
-- Run this once to add indexes for faster queries
-- =====================================================

-- 1. FULLTEXT index for fast text search (replaces slow LIKE '%keyword%')
ALTER TABLE registrations
  ADD FULLTEXT INDEX ft_search (id_number, first_name, last_name, license_plate, phone);

-- 2. Composite index for common filter + sort pattern (status filter + date sort)
ALTER TABLE registrations
  ADD INDEX idx_status_regdate (status, registered_at DESC);

-- 3. Composite index for type + status filter
ALTER TABLE registrations
  ADD INDEX idx_type_status (user_type, status);

-- 4. Index for date-range queries in reports
ALTER TABLE registrations
  ADD INDEX idx_registered_at (registered_at);

-- 5. Composite index for violations date queries
ALTER TABLE violations
  ADD INDEX idx_recorded_at (recorded_at);

-- 6. Index for province aggregation in reports
ALTER TABLE registrations
  ADD INDEX idx_province_status (province, status);

-- 7. License plate prefix search (already UNIQUE, but explicit index helps)
-- Already has uq_plate unique key, skip

SELECT 'All indexes created successfully!' AS result;

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('table').forEach(table => {
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return; // Only process standard data tables

    const headers = thead.querySelectorAll('th');
    headers.forEach((th, i) => {
      const text = th.textContent.trim();
      // Skip empty headers or Action columns meant for buttons
      if (!text || text.includes('จัดการ') || text === 'Action') return;
      
      // UI enhancements for clickable headers
      th.style.cursor = 'pointer';
      th.classList.add('hover:bg-slate-100', 'transition-colors', 'select-none');
      th.title = 'คลิกเพื่อเรียงลำดับ';
      
      // Inject sorting icon wrapper
      th.innerHTML = `<div class="flex items-center gap-1">${th.innerHTML}<span class="sort-icon text-xs text-slate-400 opacity-50 transition-all">↕</span></div>`;

      let asc = true;
      th.addEventListener('click', () => {
        // Reset all icons in this table
        headers.forEach(h => {
          const icon = h.querySelector('.sort-icon');
          if (icon) {
            icon.textContent = '↕';
            icon.classList.remove('text-blue-600', 'font-bold');
            icon.classList.add('opacity-50');
          }
        });

        // Update clicked icon
        const currentIcon = th.querySelector('.sort-icon');
        if (currentIcon) {
          currentIcon.textContent = asc ? '↓' : '↑';
          currentIcon.classList.remove('opacity-50');
          currentIcon.classList.add('text-blue-600', 'font-bold');
        }

        // Get array of rows
        const rows = Array.from(tbody.querySelectorAll('tr'));
        
        // Sort rows
        rows.sort((a, b) => {
          const aCol = a.querySelectorAll('td')[i];
          const bCol = b.querySelectorAll('td')[i];
          if (!aCol || !bCol) return 0;
          
          let aText = aCol.textContent.trim();
          let bText = bCol.textContent.trim();

          // Try date parsing with support for Thai formats (DD/MM/YYYY or DD MMM YYYY)
          const parseCustomDate = (text) => {
            // Check DD/MM/YYYY (e.g. 15/3/2567)
            const mSlash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (mSlash) {
              return new Date(parseInt(mSlash[3]), parseInt(mSlash[2]) - 1, parseInt(mSlash[1])).getTime();
            }
            // Check DD Mon YYYY
            const thaiMonths = {
              'ม.ค.':0, 'มกราคม':0, 'ก.พ.':1, 'กุมภาพันธ์':1, 'มี.ค.':2, 'มีนาคม':2, 'เม.ย.':3, 'เมษายน':3,
              'พ.ค.':4, 'พฤษภาคม':4, 'มิ.ย.':5, 'มิถุนายน':5, 'ก.ค.':6, 'กรกฎาคม':6, 'ส.ค.':7, 'สิงหาคม':7,
              'ก.ย.':8, 'กันยายน':8, 'ต.ค.':9, 'ตุลาคม':9, 'พ.ย.':10, 'พฤศจิกายน':10, 'ธ.ค.':11, 'ธันวาคม':11
            };
            const parts = text.split(/\s+/);
            if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[2])) {
              const monthIndex = thaiMonths[parts[1]];
              if (monthIndex !== undefined) {
                return new Date(parseInt(parts[2]), monthIndex, parseInt(parts[0])).getTime();
              }
            }
            // Fallback for standard formats
            if (text.match(/^\d{4}-\d{2}-\d{2}/) || text.includes(',')) {
              return Date.parse(text);
            }
            return NaN;
          };

          const dateA = parseCustomDate(aText);
          const dateB = parseCustomDate(bText);
          if (!isNaN(dateA) && !isNaN(dateB)) {
             return asc ? dateA - dateB : dateB - dateA;
          }
          
          // Try number parsing (strip commas)
          const aNum = parseFloat(aText.replace(/,/g, ''));
          const bNum = parseFloat(bText.replace(/,/g, ''));
          if (!isNaN(aNum) && !isNaN(bNum) && /^[0-9.,]+$/.test(aText.split(' ')[0])) {
            return asc ? aNum - bNum : bNum - aNum;
          }
          
          // Fallback to Thai locale string comparison
          return asc ? aText.localeCompare(bText, 'th') : bText.localeCompare(aText, 'th');
        });
        
        // Re-append sorted rows (this preserves event listeners on buttons inside rows)
        tbody.innerHTML = '';
        rows.forEach(row => tbody.appendChild(row));
        
        // Toggle sort direction for next click
        asc = !asc;
      });
    });
  });
});

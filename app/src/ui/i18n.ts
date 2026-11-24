export type Lang = 'ar' | 'en';

const dict: Record<Lang, Record<string, string>> = {
  ar: {
    title: 'مدّ — خريطة المد والجزر',
    subtitle: 'ارتفاع البحر يتغيّر مع المد، فتظهر الجزر وتختفي',
    stations: 'محطات المد',
    search: 'ابحث عن محطة…',
    noStations: 'لا توجد نتائج',
    level: 'مستوى الماء',
    rising: 'صاعد',
    falling: 'هابط',
    highWater: 'مدّ عالي',
    lowWater: 'مدّ منخفض',
    range: 'مدى المد',
    accuracy: 'دقة النموذج',
    nextHigh: 'المدّ العالي القادم',
    jumpHigh: 'اذهب للمدّ العالي',
    jumpLow: 'اذهب للمدّ المنخفض',
    nextLow: 'المدّ المنخفض القادم',
    timeline: 'الزمن',
    now: 'الآن',
    play: 'تشغيل',
    pause: 'إيقاف',
    speed: 'السرعة',
    exaggeration: 'مبالغة المد',
    bias: 'إزاحة مستوى البحر',
    opacity: 'شفافية الخريطة الطوبوغرافية',
    addIsland: 'إضافة جزيرة',
    addIslandHint: 'انقر على الخريطة لإضافة جزيرة',
    islandElevation: 'ارتفاع الجزيرة (م)',
    islandRadius: 'نصف قطر الجزيرة (كم)',
    flooded: 'غمرها المد',
    exposed: 'ظاهرة',
    removeIsland: 'حذف',
    source: 'المصدر',
    mapStatus: 'حالة الخريطة',
    searchPlaceholder: 'ابحث عن مكان أو محطة مدّ…',
    searchHint: 'مثال: جدة · مكة · Pacific Ocean',
    demLayer: 'طبقة المدّ (أرض رقمية)',
    demOn: 'طبقة المدّ مُفعّلة',
    demOff: 'طبقة المدّ متوقفة',
    retry: 'إعادة المحاولة',
    basemapUnavailable: 'الخريطة الأساسية غير متاحة',
    terrainNeedsWebgl: 'تتطلّب طبقة التضاريس WebGL 2',
    rotateHint: 'اسحب بالزر الأيمن للتدوير · Ctrl+سحب للإمالة',
    liveNoaa: 'تنبؤات NOAA الرسمية (مباشرة)',
    offlineModel: 'النموذج المحلي (بدون اتصال)',
    loading: 'جارٍ التحميل…',
    error: 'تعذّر تحميل البيانات',
    exportPng: 'حفظ صورة',
    labels: 'التسميات',
    tideCurve: 'منحنى المد',
    window: 'نافذة 48 ساعة',
    depth: 'العمق',
    elevation: 'الارتفاع',
    seaLevel: 'مستوى سطح البحر',
    land: 'اليابسة',
    water: 'الماء',
    about: 'عن التطبيق',
    aboutBody:
      'يرسم هذا التطبيق نموذج الارتفاع الرقمي العالمي (SRTM/ETOPO) ويقارنه بمستوى سطح البحر المحسوب من ثوابت المد، ' +
      'فتحتفيق بالجزر والسباخ Shoals مع كل مدّ، وتظهر الهدور والمجاري التي لا تغطيها المياه إلا في وقت المد.',
    langLabel: 'English',
    allStations: 'كل المحطات',
    nearest: 'الأقرب إليك',
    dataNote: 'الثوابت مشتقّة من تنبؤات NOAA الرسمية عبر أقل squares fit على 2024–2026.',
  },
  en: {
    title: 'Madd — Tide & Islands Atlas',
    subtitle: 'The sea rises and falls with the tide, so islands appear and vanish',
    stations: 'Tide stations',
    search: 'Search for a station…',
    noStations: 'No results',
    level: 'Water level',
    rising: 'rising',
    falling: 'falling',
    highWater: 'high water',
    lowWater: 'low water',
    range: 'Tidal range',
    accuracy: 'Model accuracy',
    nextHigh: 'Next high water',
    jumpHigh: 'Go to high water',
    jumpLow: 'Go to low water',
    nextLow: 'Next low water',
    timeline: 'Time',
    now: 'Now',
    play: 'Play',
    pause: 'Pause',
    speed: 'Speed',
    exaggeration: 'Tide exaggeration',
    bias: 'Sea-level bias',
    opacity: 'Terrain opacity',
    addIsland: 'Add island',
    addIslandHint: 'Click the map to place an island',
    islandElevation: 'Island elevation (m)',
    islandRadius: 'Island radius (km)',
    flooded: 'flooded',
    exposed: 'exposed',
    removeIsland: 'remove',
    source: 'Source',
    mapStatus: 'Map status',
    searchPlaceholder: 'Search for a place or tide station…',
    searchHint: 'e.g. Jeddah · Mecca · Pacific Ocean',
    demLayer: 'Tide layer (elevation)',
    demOn: 'Tide layer on',
    demOff: 'Tide layer off',
    retry: 'Retry',
    basemapUnavailable: 'Basemap unavailable',
    terrainNeedsWebgl: 'Terrain requires WebGL 2',
    rotateHint: 'Right-drag to rotate · Ctrl+drag to tilt',
    liveNoaa: 'Official NOAA predictions (live)',
    offlineModel: 'Local model (offline)',
    loading: 'Loading…',
    error: 'Could not load data',
    exportPng: 'Save image',
    labels: 'Labels',
    tideCurve: 'Tide curve',
    window: '48-hour window',
    depth: 'Depth',
    elevation: 'Elevation',
    seaLevel: 'Sea level',
    land: 'Land',
    water: 'Water',
    about: 'About',
    aboutBody:
      'The app renders the global digital elevation model (SRTM/ETOPO) and compares it with the sea level computed from ' +
      'harmonic tide constants, so shoals and low islands emerge with every tide.',
    langLabel: 'العربية',
    allStations: 'All stations',
    nearest: 'Nearest to you',
    dataNote: 'Constants derived from official NOAA predictions by least squares over 2024–2026.',
  },
};

let current: Lang = 'ar';

export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
}

export function getLang(): Lang {
  return current;
}

export function t(key: string): string {
  return dict[current][key] ?? dict.en[key] ?? key;
}

/** Arabic-Indic digits when the interface is Arabic */
export function fmt(value: number, digits = 2): string {
  if (!isFinite(value)) return '—';
  const s = value.toFixed(digits);
  if (current === 'ar') {
    return s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).replace('.', '٫');
  }
  return s;
}

export function fmtTime(ms: number, withDate = true): string {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = withDate
    ? {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}
    : {hour: '2-digit', minute: '2-digit'};
  return new Intl.DateTimeFormat(current === 'ar' ? 'ar-EG' : 'en-GB', opts).format(d);
}

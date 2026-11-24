export interface Constituent {
  /** constituent name, e.g. M2 */
  n: string;
  /** amplitude in metres */
  a: number;
  /** Greenwich phase lag in degrees */
  g: number;
  /** astronomical speed in degrees per hour */
  w: number;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  state?: string;
  /** mean tidal range in metres */
  meanRange: number;
  /** constant offset (mean level) in metres */
  offset: number;
  /** constants fitted against official NOAA predictions */
  const: Constituent[];
  /** constants as published by NOAA CO-OPS */
  published?: Constituent[];
  /** validation error of the fit against the official predictions, in cm */
  accuracy?: {maxCm: number; rmseCm: number};
}

export interface StationFile {
  generated: string;
  source: string;
  stations: Station[];
}

export interface TidePoint {
  t: number;
  v: number;
  /** 'H' high water, 'L' low water, undefined for intermediate values */
  type?: 'H' | 'L';
}

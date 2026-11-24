/**
 * TideDemLayer — custom MapLibre layer that renders a global elevation model
 * (AWS Terrain Tiles / "terrarium" encoding) and turns it into a *tide-aware*
 * map: everything below the current sea level becomes water, everything above
 * becomes land. Islands therefore appear and disappear as the tide rises.
 */
import type {CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap} from 'maplibre-gl';

const TILE_SIZE = 256;
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_ZOOM = 15;
const CACHE_LIMIT = 260;

const VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_uv;
uniform mat4 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_elev;
uniform float u_tide;      // sea level in metres (relative to mean sea level)
uniform float u_exag;      // vertical exaggeration applied to the tide
uniform float u_bias;      // manual sea-level bias in metres
uniform float u_time;      // seconds, for wave animation
uniform float u_alpha;
uniform vec2  u_scale;     // tile pixel size in the mercator square
out vec4 fragColor;

float elevAt(vec2 uv) {
  return texture(u_elev, uv).r;
}

void main() {
  float e = elevAt(v_uv);
  float sea = u_tide * u_exag + u_bias;
  float depth = sea - e;               // > 0 => below the water line
  vec3 col;

  if (depth > 0.0) {
    float dn = clamp(depth / 45.0, 0.0, 1.0);
    vec3 shallow = vec3(0.36, 0.74, 0.80);
    vec3 mid     = vec3(0.09, 0.42, 0.60);
    vec3 deep    = vec3(0.02, 0.11, 0.28);
    col = mix(shallow, mid, smoothstep(0.0, 0.28, dn));
    col = mix(col, deep, smoothstep(0.25, 1.0, pow(dn, 0.75)));

    // travelling swell, strongest in shallow water
    float w = sin((v_uv.x * 190.0 + v_uv.y * 110.0) + u_time * 1.35)
            + sin((v_uv.x * 90.0 - v_uv.y * 140.0) - u_time * 0.9);
    col += (w * 0.5) * 0.045 * (1.0 - dn);

    // bright foam line right at the water edge
    float edge = smoothstep(1.6, 0.0, depth);
    col = mix(col, vec3(0.92, 0.97, 0.99), edge * 0.55);
  } else {
    float h = -depth;                  // height above the current water line
    float t = h / 900.0;
    vec3 sand  = vec3(0.87, 0.83, 0.62);
    vec3 grass = vec3(0.45, 0.60, 0.36);
    vec3 forest= vec3(0.24, 0.40, 0.23);
    vec3 rock  = vec3(0.55, 0.50, 0.44);
    vec3 snow  = vec3(0.95, 0.96, 0.97);
    col = mix(sand, grass, smoothstep(0.0, 0.05, t));
    col = mix(col, forest, smoothstep(0.04, 0.22, t));
    col = mix(col, rock,  smoothstep(0.28, 0.68, t));
    col = mix(col, snow,  smoothstep(0.78, 1.0, t));

    // the inter-tidal belt: ground that this tide cycle will cover
    float inter = smoothstep(4.0, 0.0, h);
    col = mix(col, vec3(0.80, 0.72, 0.42), inter * 0.40);

    // hillshade from the elevation gradient
    float tx = 1.0 / 256.0;
    float hx = elevAt(v_uv + vec2(tx, 0.0)) - elevAt(v_uv - vec2(tx, 0.0));
    float hy = elevAt(v_uv + vec2(0.0, tx)) - elevAt(v_uv - vec2(0.0, tx));
    float shade = clamp(0.5 + (hx - hy) * 0.035, 0.0, 1.4);
    col *= mix(1.0, shade, 0.55);
  }

  fragColor = vec4(col, u_alpha);
}`;

interface TileEntry {
  tex: WebGLTexture;
  x: number;
  y: number;
}

function toHalf(val: number): number {
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  f32[0] = val;
  const x = i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

export interface TideDemOptions {
  /** sea level in metres relative to mean sea level */
  tide: number;
  /** vertical exaggeration of the tide (1 = true scale) */
  exaggeration: number;
  /** manual sea level bias in metres */
  bias: number;
  opacity: number;
  onTileError?: (url: string) => void;
}

export class TideDemLayer implements CustomLayerInterface {
  id = 'tide-dem';
  type = 'custom' as const;
  renderingMode = '2d' as const;

  private map!: MapLibreMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private buffer!: WebGLBuffer;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private textures = new Map<string, TileEntry>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private currentZoom = -1;
  private opts: TideDemOptions = {tide: 0, exaggeration: 1, bias: 0, opacity: 1};
  private canvas: OffscreenCanvas | HTMLCanvasElement = document.createElement('canvas');

  constructor(private options: Partial<TideDemOptions> = {}) {
    this.opts = {...this.opts, ...options};
  }

  setTide(tide: number, exaggeration: number, bias: number) {
    this.opts.tide = tide;
    this.opts.exaggeration = exaggeration;
    this.opts.bias = bias;
  }

  setOpacity(v: number) {
    this.opts.opacity = v;
  }

  /** حالة تحميل بلاطات الارتفاع (مفيد لتشخيص انقطاع الشبكة) */
  get stats() {
    return {loaded: this.textures.size, failed: this.failed.size, pending: this.pending.size};
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
        : Object.assign(document.createElement('canvas'), {width: TILE_SIZE, height: TILE_SIZE});

    const program = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('DEM shader: ' + gl.getShaderInfoLog(sh));
      }
      gl.attachShader(program, sh);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('DEM program: ' + gl.getProgramInfoLog(program));
    }
    this.program = program;

    this.uniforms = {
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      elev: gl.getUniformLocation(program, 'u_elev'),
      tide: gl.getUniformLocation(program, 'u_tide'),
      exag: gl.getUniformLocation(program, 'u_exag'),
      bias: gl.getUniformLocation(program, 'u_bias'),
      time: gl.getUniformLocation(program, 'u_time'),
      alpha: gl.getUniformLocation(program, 'u_alpha'),
      scale: gl.getUniformLocation(program, 'u_scale'),
    };

    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // 4 vertices: (mercator x, mercator y, u, v)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]),
      gl.DYNAMIC_DRAW,
    );
    const stride = 4 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.bindVertexArray(null);

    map.on('move', this.onMove);
  }

  private onMove = () => {
    const z = this.desiredZoom();
    if (z !== this.currentZoom) this.ensureTiles(z);
  };

  private desiredZoom(): number {
    const z = Math.round(this.map.getZoom());
    return Math.max(0, Math.min(MAX_ZOOM, z));
  }

  /** Loads the tiles covering the current viewport at the given zoom level. */
  ensureTiles(z: number) {
    this.currentZoom = z;
    const n = Math.pow(2, z);
    const b = this.map.getBounds();
    const west = b.getWest();
    const east = b.getEast();
    const north = b.getNorth();
    const south = b.getSouth();

    const lonToX = (lon: number) => (lon + 180) / 360;
    const latToY = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };

    const x0 = Math.floor(lonToX(west) * n);
    const x1 = Math.floor(lonToX(east) * n);
    const y0 = Math.floor(latToY(north) * n);
    const y1 = Math.floor(latToY(south) * n);

    const wanted: string[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const wrapped = ((x % n) + n) % n;
        if (y < 0 || y >= n) continue;
        const key = `${z}/${wrapped}/${y}`;
        if (!this.textures.has(key) && !this.pending.has(key) && !this.failed.has(key)) {
          wanted.push(key);
        }
      }
    }
    for (const key of wanted) void this.loadTile(key);
    this.evict();
  }

  private async loadTile(key: string) {
    this.pending.add(key);
    const [z, x, y] = key.split('/');
    const url = DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    try {
      const res = await this.map.loadImage(url);
      const img = res.data as unknown as HTMLImageElement;
      const tex = this.uploadTile(img);
      this.textures.set(key, {tex, x: Number(x), y: Number(y)});
    } catch (e) {
      this.failed.add(key);
      this.options.onTileError?.(url);
    } finally {
      this.pending.delete(key);
    }
  }

  private uploadTile(img: HTMLImageElement): WebGLTexture {
    const gl = this.gl;
    const ctx = (this.canvas as OffscreenCanvas).getContext('2d', {willReadFrequently: true}) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
    const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;

    const half = new Uint16Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0, p = 0; i < half.length; i++, p += 4) {
      const elev = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
      half[i] = toHalf(elev);
    }

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TILE_SIZE, TILE_SIZE, 0, gl.RED, gl.HALF_FLOAT, half);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private evict() {
    if (this.textures.size <= CACHE_LIMIT) return;
    const entries = [...this.textures.entries()];
    const drop = entries.slice(0, entries.length - CACHE_LIMIT);
    for (const [key, entry] of drop) {
      this.gl.deleteTexture(entry.tex);
      this.textures.delete(key);
    }
  }

  prerender(gl: WebGL2RenderingContext) {
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.tide, this.opts.tide);
    gl.uniform1f(this.uniforms.exag, this.opts.exaggeration);
    gl.uniform1f(this.uniforms.bias, this.opts.bias);
    gl.uniform1f(this.uniforms.alpha, this.opts.opacity);
    gl.uniform1f(this.uniforms.time, performance.now() / 1000);
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (this.currentZoom < 0) this.ensureTiles(this.desiredZoom());
    const z = this.currentZoom;
    const n = Math.pow(2, z);

    gl.useProgram(this.program);
    const matrix = args.defaultProjectionData.mainMatrix;
    gl.uniformMatrix4fv(this.uniforms.matrix!, false, matrix instanceof Float32Array ? matrix : new Float32Array(matrix));
    gl.uniform1f(this.uniforms.tide, this.opts.tide);
    gl.uniform1f(this.uniforms.exag, this.opts.exaggeration);
    gl.uniform1f(this.uniforms.bias, this.opts.bias);
    gl.uniform1f(this.uniforms.alpha, this.opts.opacity);
    gl.uniform1f(this.uniforms.time, performance.now() / 1000);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const b = this.map.getBounds();
    const lonToX = (lon: number) => (lon + 180) / 360;
    const latToY = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const x0 = Math.floor(lonToX(b.getWest()) * n);
    const x1 = Math.floor(lonToX(b.getEast()) * n);
    const y0 = Math.floor(latToY(b.getNorth()) * n);
    const y1 = Math.floor(latToY(b.getSouth()) * n);

    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uniforms.elev!, 0);

    let drawn = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const wrapped = ((x % n) + n) % n;
        const key = `${z}/${wrapped}/${y}`;
        const entry = this.textures.get(key);
        if (!entry) continue;
        const px0 = x / n;
        const px1 = (x + 1) / n;
        const py0 = y / n;
        const py1 = (y + 1) / n;
        const verts = new Float32Array([
          px0, py0, 0, 0,
          px1, py0, 1, 0,
          px0, py1, 0, 1,
          px1, py1, 1, 1,
        ]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.uniform2f(this.uniforms.scale!, 1 / n, 1 / n);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        drawn++;
      }
    }
    gl.bindVertexArray(null);
    if (drawn === 0) {
      // nothing loaded yet — keep the frame clean
    }
  }
}

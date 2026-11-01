# Plan: timeline de IDs en el workspace estándar de CVAT

Fecha: 2026-11-01 · Fork: `NoelDNathan/cvat` · Rama propuesta: `feat/track-timeline`

## 0. Objetivo

Mientras se etiqueta un vídeo con seguimiento de jugadores, ver en un panel bajo el lienzo **cuándo está viva cada ID**
(una fila por track), con keyframes, tramos ocluidos y la línea del frame actual, y poder saltar y seleccionar objetos
desde ahí.

| Fase | Contenido | ¿Escribe anotaciones? |
|---|---|---|
| **1 (este plan, en detalle)** | Panel, filas, barras vivas, ocluido, keyframes, playhead, regla, zoom, clic para saltar/seleccionar, orden y filtro simple, atajo | No (solo lectura) |
| 2 (esbozo §10) | Carril de recuento vs. esperados, avisos de track corto y de posible cambio de ID, mini timeline en el slider principal | No |
| 3 (esbozo §10) | Menú contextual: terminar aquí, partir aquí, fusionar con… (vía acciones de cvat-core, con deshacer) | Sí |

### Reglas de diseño (no negociables)

1. **cvat-core es la fuente de verdad.** El timeline solo lee `jobInstance.annotations.export()`; nunca guarda copia
   editable ni escribe anotaciones en la fase 1.
2. **Cambio acotado.** Código nuevo en archivos nuevos; en archivos existentes de CVAT, solo los enganches mínimos
   (§3.2). Así el fork se puede seguir actualizando desde upstream con pocos conflictos.
3. **Estilo de CVAT.** Textos de la UI y comentarios en inglés, como el resto de `cvat-ui`; hooks + `useSelector`
   (como `canvas-layout.tsx`), sin contenedor `connect` nuevo; SCSS con las variables de `base.scss`.

## 1. Cómo se calcula «viva» (verificado en el código)

`cvat-core/src/annotations-objects/track.ts` guarda solo **keyframes**: `shapes: Record<frame, {outside, occluded, …}>`.
En un frame `f`, la forma se interpola entre el keyframe izquierdo y el derecho, y **`outside` y `occluded` se toman del
keyframe izquierdo** (`outside: leftPosition.outside` en `rectangle-track.ts`, `poly-track.ts`, etc.).

Por tanto, con los keyframes ordenados `k0 < k1 < … < kn`:

- Antes de `k0`: la ID no existe.
- Tramo `[ki, k(i+1) − 1]`: viva si `shapes[ki].outside === false`; ocluida si además `shapes[ki].occluded === true`.
- Tras el último keyframe `kn`: si `outside === false`, viva hasta `stopFrame` del job.

Coste: O(nº de keyframes) por track, sin recorrer frames. Un partido con 30 tracks y cientos de keyframes se calcula en
microsegundos.

Datos de entrada (`SerializedTrack` en `cvat-core/src/server-response-types.ts:293`): `clientID`, `id` (servidor),
`label_id`, `attributes` (solo los inmutables), `shapes[]` con `frame`, `outside`, `occluded`, y `elements[]` para
esqueletos.

`export()` (`annotations-collection.ts:439`) ya excluye los tracks borrados (`!track.removed`).

## 2. Comportamiento de la fase 1

### 2.1 Disposición

```
┌──────────┬──────────────────────────────────────────────┬──────────────┐
│ controles│ lienzo (CanvasLayout)                        │ objetos (320)│
│          │                                              │  (absoluto)  │
│          ├──────────────────────────────────────────────┤              │
│          │ ═ asa de redimensionado                       │              │
│          │ [cabecera: título · orden · filtro · ⌄]       │              │
│          │ regla de frames + capítulos          │playhead│              │
│          │ #1 local 7   ████████   ██████████████        │              │
│          │ #2 local 10  ███████████▒▒▒▒▒                 │              │
└──────────┴──────────────────────────────────────────────┴──────────────┘
```

- Panel acoplado bajo el lienzo, a lo ancho de la zona central.
- La barra de objetos es `position: absolute` con ancho 320 (`objects-side-bar.tsx:108`) y tapa la derecha:
  el panel deja `margin-right: 320px` cuando `state.annotation.sidebarCollapsed === false` y 0 si está plegada
  (comprobar la altura real de la barra; si no llega al fondo, ajustar).
- Altura por defecto 180 px; mínima 80; máxima 50 % de la ventana. Se arrastra con un asa en el borde superior.
- Plegado: queda solo la cabecera (28 px). Estado abierto/plegado y altura se recuerdan en `localStorage`
  (clave `cvat.trackTimeline`, lecturas y escrituras en `try/catch`).

### 2.2 Contenido

- **Columna izquierda (180 px):** punto con el color de la etiqueta, `#clientID` (el mismo número que enseña la barra
  lateral, `object-item-basics.tsx:298`) y nombre de la etiqueta. Opcional (§2.5): valor de un atributo, p. ej. dorsal.
- **Regla (24 px):** marcas de frame adaptadas al zoom (cada 1/5/10/50/100/500…) y capítulos (`state.annotation.job.meta`
  / los mismos `chapters` que usa `player-navigation.tsx`).
- **Filas (20 px):** barras redondeadas donde la ID está viva; relleno rayado donde está ocluida; huecos donde está
  *outside*. Rombos en los keyframes, solo si caben (separación ≥ 6 px a ese zoom).
- **Frames borrados:** franjas grises de fondo (misma fuente que el slider cuando `showDeletedFrames`).
- **Playhead:** línea vertical en `state.annotation.player.frame.number`.
- **Fila activa:** fondo resaltado si `clientID === state.annotation.annotations.activatedStateID`; se hace scroll
  vertical hasta ella cuando cambia la activación desde fuera.

### 2.3 Interacciones

| Gesto | Acción |
|---|---|
| Clic en la regla o en zona vacía | Saltar a ese frame |
| Clic en una barra | Saltar al frame bajo el cursor y activar esa ID |
| Clic en un rombo | Saltar a ese keyframe y activar la ID |
| Clic en la etiqueta de la fila | Si la ID está viva en el frame actual, activarla; si no, saltar al inicio del tramo vivo más cercano (el siguiente; si no hay, el anterior) y activarla |
| Ratón sobre una fila | Si la ID está viva en el frame actual, `activateObject(clientID)` (igual que `onMouseEnter` en la barra lateral, `object-item.tsx:184`); tooltip con tramos `inicio–fin` |
| `ctrl` + rueda | Zoom horizontal anclado en el cursor (×1 … ×64) |
| Rueda / `shift` + rueda | Scroll vertical / horizontal |
| Atajo `SWITCH_TRACK_TIMELINE` | Abrir/plegar el panel |

Reglas de seguridad al saltar:

- Si `state.annotation.player.navigationBlocked`, no hacer nada.
- Si está reproduciendo (`player.playing`), pausar primero con `switchPlay(false)`.
- Activar **después** de que termine `await dispatch(changeFrameAsync(frame))`, porque el objeto tiene que existir en
  los `states` del nuevo frame.
- Respetar el bloqueo de simplificación: `activateObject` ya lo hace (`annotation-actions.ts:969`).
- Durante la reproducción, si el playhead sale de la vista, desplazar la vista para seguirlo.

### 2.4 Orden y filtro

- Orden: por primera aparición (por defecto), por ID, por etiqueta. Selector en la cabecera.
- Filtro rápido: un campo de texto que filtra por `#id` o por nombre de etiqueta, y un conmutador «solo vivas en este
  frame».
- Los filtros avanzados de CVAT (`annotations.filters`) quedan para la fase 2: se aplican a `ObjectState` de un frame, no
  a tracks serializados, y adaptarlos no es trivial.

### 2.5 Atributo visible (opcional dentro de la fase 1)

Selector «Show attribute» con los atributos **inmutables** de las etiquetas (los únicos que trae `toJSON()` a nivel de
track). Si el proyecto tiene un atributo `number`/`dorsal`, la fila enseña `#3 · 10`. Si se complica, se pasa a la
fase 2.

### 2.6 Qué NO hace la fase 1

No edita anotaciones ni keyframes, no aplica filtros avanzados, no muestra shapes sueltas ni tags (solo tracks), y no
se integra en los workspaces de atributos, revisión, single-shape, 3D ni audio.

## 3. Archivos

### 3.1 Nuevos

| Archivo | Contenido |
|---|---|
| `cvat-ui/src/utils/track-timeline.ts` | Lógica pura, **sin imports**: tipos, cálculo de tramos, filas, orden, escala frame↔px, paso de la regla |
| `cvat-ui/src/utils/track-timeline.test.ts` | Tests con `node:test` (§5.1) |
| `cvat-ui/src/components/annotation-page/standard-workspace/track-timeline/track-timeline.tsx` | Panel: cabecera, asa, plegado, persistencia, carga de datos, atajo |
| `…/track-timeline/timeline-canvas.tsx` | SVG de regla, filas visibles, playhead; eventos de ratón y rueda |
| `…/track-timeline/use-timeline-rows.ts` | Hook: export con debounce + `buildTimelineRows` memoizado |
| `…/track-timeline/styles.scss` | Estilos del panel |

API de `track-timeline.ts`:

```ts
export interface TimelineKeyframe { frame: number; outside: boolean; occluded: boolean; }
export interface TimelineSegment { start: number; stop: number; occluded: boolean; } // ambos inclusive
export interface TimelineRow {
    clientID: number;
    serverID: number | null;
    labelID: number;
    labelName: string;
    color: string;
    segments: TimelineSegment[]; // ordenados, sin solapes; tramos contiguos con el mismo occluded fusionados
    keyframes: number[];
    firstFrame: number | null;   // null si nunca está viva en el rango del job
    lastFrame: number | null;
    attributeValue?: string;
}
export type TimelineSortMode = 'first_appearance' | 'id' | 'label';

export function computeSegments(keyframes: TimelineKeyframe[], startFrame: number, stopFrame: number): TimelineSegment[];
export function mergeSegments(lists: TimelineSegment[][]): TimelineSegment[]; // unión, para esqueletos
export function isAliveAt(segments: TimelineSegment[], frame: number): boolean; // búsqueda binaria
export function nearestAliveFrame(segments: TimelineSegment[], frame: number): number | null;
export function buildTimelineRows(
    tracks: TimelineTrackInput[],                 // subconjunto estructural de SerializedTrack
    labels: { id: number; name: string; color: string }[],
    startFrame: number, stopFrame: number,
): TimelineRow[];
export function sortRows(rows: TimelineRow[], mode: TimelineSortMode): TimelineRow[];
export function rulerStep(pxPerFrame: number): number; // 1, 5, 10, 50, 100, 500, 1000…
```

`TimelineTrackInput` se declara a mano (estructural) en vez de importar `SerializedTrack`, para que el archivo no tenga
imports y se pueda testear con Node sin webpack ni alias.

### 3.2 Modificados (enganches mínimos)

| Archivo | Cambio |
|---|---|
| `standard-workspace/standard-workspace.tsx` | Envolver `<CanvasLayout />` y el nuevo `<TrackTimeline />` en un `Layout` vertical (`cvat-standard-workspace-center`) |
| `standard-workspace/styles.scss` | `flex-direction: column` del contenedor central; el lienzo ocupa el resto |
| `canvas/grid-layout/canvas-layout.tsx` | `computeRowHeight()` (línea ~157) usa `window.innerHeight − bottom(header)`: hay que **restar además la altura de `.cvat-track-timeline`** si existe. Sin esto el lienzo queda tapado por el panel |
| (sin cambio de reducer) | El panel avisa al lienzo con `window.dispatchEvent(new Event('resize'))` al abrir, plegar o soltar el asa; `canvas-layout` ya escucha `resize` y llama a `fitCanvas()` |

El atajo se registra en el propio componente con `registerComponentShortcuts` (patrón de `player-navigation.tsx:60-82`),
con `scope: ShortcutScope.ANNOTATION_PAGE`. Secuencia propuesta: `alt+t` (no he encontrado `t` ocupada, pero hay que
confirmarlo en el modal de atajos; `alt+` evita chocar con la escritura en campos de texto).

## 4. Datos: carga y refresco

`use-timeline-rows.ts`:

1. Lee de redux: `job.instance`, `job.labels`, `annotations.history`, `annotations.initialized`.
2. `useEffect` sobre `[jobInstance, history, initialized]`, con debounce de 300 ms:
   `const { tracks } = await jobInstance.annotations.export();`, luego `buildTimelineRows(tracks, labels, job.startFrame,
   job.stopFrame)`.
3. **Por qué `history`:** el reducer de anotaciones (`annotation-reducer.ts`) crea un objeto `history` nuevo en cada
   acción que cambia anotaciones (actualizar, crear, fusionar, partir, agrupar, borrar, deshacer/rehacer, propagar,
   cargar el job; líneas 398, 433, 653, 687, 814, 893, 1092). **No** usar `annotations.states` como dependencia: cambia
   en cada frame y durante la reproducción recalcularía unas 25 veces por segundo.
4. Comprobar a mano las rutas que podrían no tocar `history` (importar anotaciones, trackers automáticos, acciones
   de anotación por lotes). Si alguna no lo hace, añadir esa acción concreta como dependencia; no recalcular por frame.
5. Medir `export()` en un job grande (objetivo < 50 ms). Si se pasa, cachear por `clientID` y recalcular solo los tracks
   tocados (el undo de `history` trae el `clientID`).
6. Si el panel está plegado, no recalcular (marcar sucio y calcular al abrir).

## 5. Pruebas

### 5.1 Unitarias de la lógica pura (antes que la UI)

`cvat-ui` no tiene runner de tests unitarios (solo Cypress en `tests/`). Node 24 ejecuta `.ts` con *type stripping*,
así que, con un archivo sin imports ni `enum`:

```bash
node --test cvat-ui/src/utils/track-timeline.test.ts
```

Casos mínimos:

1. Un keyframe visible y nada más → viva hasta `stopFrame`.
2. `visible@0, outside@120, visible@140` → `[0,119]` y `[140,stop]`.
3. Último keyframe `outside` → la barra termina en el frame anterior a ese keyframe.
4. Ocluido `occluded@60, visible@90` → tramo ocluido `[60,89]` y fusión de contiguos con el mismo `occluded`.
5. Keyframes fuera del rango del job → recorte a `[startFrame, stopFrame]`; un keyframe izquierdo anterior a
   `startFrame` decide el estado al empezar.
6. Track siempre `outside` → sin tramos, `firstFrame === null`.
7. Keyframes desordenados en la entrada → mismo resultado.
8. Esqueleto (`shapes` vacío, `elements` con keyframes) → unión de los tramos de los elementos.
9. `isAliveAt` / `nearestAliveFrame` en bordes (inicio, fin, hueco, después del último tramo).
10. `sortRows` estable en los tres modos; `rulerStep` monótono.

### 5.2 Comprobación en el navegador (lista)

1. Crear una tarea con un vídeo corto y 3 tracks: uno continuo, uno con un tramo *outside* y otro con un tramo ocluido.
2. Las barras coinciden con lo que se ve al recorrer frames (comprobar los frames de borde: el anterior al `outside` y el
   propio `outside`).
3. Al editar (añadir keyframe, cambiar `outside`, borrar un track, deshacer) el timeline se actualiza en < 0,5 s.
4. Clic en una barra salta y activa (la caja queda resaltada en el lienzo y en la lista lateral).
5. Abrir y plegar el panel y arrastrar el asa: el lienzo se reajusta sin quedar tapado.
6. Reproducir: el playhead avanza y la vista lo sigue; la consola no muestra avisos de rendimiento.
7. Barra lateral plegada y desplegada: el panel no queda debajo de ella.
8. Job con varios cientos de tracks (se puede generar con la API): el scroll va fluido (solo se pintan las filas
   visibles).

### 5.3 Cypress (opcional, al final)

`tests/cypress/e2e/actions_objects2/case_XXX_track_timeline.js`, siguiendo `case_22_tag_annotation_mode.js`: crear una
tarea, dibujar un track, poner `outside` en un frame y comprobar la longitud de la barra y el salto al hacer clic.
Requiere el entorno de tests de CVAT, así que no bloquea la fase 1.

## 6. Bucle de desarrollo

- **Backend:** el `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build` que ya lanzaste
  (construye también `cvat_ui` desde el fork con `Dockerfile.ui`).
- **UI con recarga en caliente (recomendado mientras se programa):** el servidor de webpack sirve en `localhost:3000`
  y reenvía `/api` al backend. El script `start` apunta a `localhost:7000`; con docker el backend está detrás de traefik
  en `8080`:

  ```bash
  corepack enable
  yarn install
  yarn workspace cvat-ui webpack serve --env API_URL=http://localhost:8080 --config ./webpack.config.js --mode=development
  ```

  Si el login falla por CSRF u origen (el proxy cambia el host), la alternativa segura es reconstruir solo la UI:
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build cvat_ui` (más lento, sin recarga
  en caliente).
- **Calidad:** `yarn workspace cvat-ui run lint` y el type-check de webpack (`ForkTsChecker`) sin errores nuevos.
- **git en D:** el disco no guarda propietario; usar `git -c safe.directory=D:/noel/folders/projects/Rucklab-v2/cvat …`
  o añadir la excepción global si se prefiere.

## 7. Pasos de implementación (en orden, un commit cada uno)

1. Crear la rama `feat/track-timeline`.
2. `track-timeline.ts` + tests (§5.1) en verde. **Sin UI todavía.**
3. `use-timeline-rows.ts`: export con debounce y log temporal del nº de filas y del tiempo de cálculo; comprobar en el
   navegador que se recalcula al editar y no al cambiar de frame. Quitar el log.
4. Enganche de disposición: `standard-workspace.tsx`, `styles.scss` y `computeRowHeight` con un panel vacío de altura
   fija. Comprobar que el lienzo se reajusta (§5.2 puntos 5 y 7).
5. `timeline-canvas.tsx` en lectura: regla, filas virtualizadas, barras, ocluido, rombos, playhead y fila activa.
6. Interacciones (§2.3) con las reglas de seguridad al saltar.
7. Zoom/scroll y seguimiento del playhead.
8. Cabecera: orden, filtro, plegado, asa, persistencia y atajo.
9. (Opcional) atributo visible (§2.5).
10. Pasar la lista §5.2 completa, lint y type-check; añadir el fragmento en `changelog.d/` si se quiere proponer upstream.

## 8. Rendimiento

- Las filas se calculan una vez por cambio de anotaciones, no por frame.
- Al cambiar de frame solo se mueve el playhead (un `<line>`) y se recalcula la fila activa; el resto del SVG está
  memoizado (`React.memo` por fila con `segments` estables).
- Virtualización vertical: solo se pintan `ceil(alto / 20) + 4` filas.
- Recorte horizontal: por fila, solo los tramos que cortan la ventana visible (búsqueda binaria); ancho mínimo 1 px.
- Rombos ocultos cuando no caben.

## 9. Riesgos y cómo se cubren

| Riesgo | Mitigación |
|---|---|
| El panel tapa el lienzo o la barra lateral | `computeRowHeight` resta la altura del panel; `margin-right` según `sidebarCollapsed`; comprobaciones §5.2 |
| Recalcular demasiado (lento al reproducir) | Dependencia `history`, nunca `states`; debounce; nada si está plegado |
| Activar un objeto que no existe en el frame | Activar solo tras `await changeFrameAsync`, o solo si `isAliveAt` |
| Conflictos al actualizar desde upstream | Código nuevo aislado; 3 archivos existentes con cambios pequeños |
| `outside`/`occluded` mal interpretados | Regla del keyframe izquierdo verificada en el código + tests de bordes |

## 10. Fases siguientes (esbozo)

**Fase 2 (solo lectura):**

- Carril de recuento: IDs vivas por frame frente a «esperados» (configurable, p. ej. 22 + 3) y frames en rojo donde
  falta alguien.
- Avisos: track corto (< N frames) y posible cambio de ID (fin de un track y comienzo de otro de la misma etiqueta a
  ≤ K frames y ≤ D px de distancia, usando los `points` de los keyframes de borde). Conector discontinuo entre ambos.
- Mini timeline del objeto activo en el slider principal, por el hueco de plugins
  `plugins.components.annotationPage.player.slider`.
- Filtros avanzados de CVAT aplicados a las filas.

**Fase 3 (edición, con deshacer):** menú contextual sobre la fila o la barra: «End track here» (`outside` en el frame
actual), «Split here» y «Merge with…» (preseleccionando el candidato del aviso de cambio de ID). Todo mediante las
acciones existentes de cvat-core / `annotation-actions.ts` para que queden en `history`.

## 11. Decisiones abiertas

| Decisión | Opciones | Recomendación |
|---|---|---|
| Atajo | `alt+t` / otro libre | `alt+t`, tras confirmar que está libre en el modal de atajos |
| Estado inicial del panel | abierto / plegado | Abierto la primera vez y luego lo que recuerde `localStorage` |
| Número que se muestra | `clientID` / ID de servidor | `clientID`, el mismo que la barra lateral |
| Atributo visible | dentro de la fase 1 / fase 2 | Fase 1 si sale en < 1 h; si no, fase 2 |
| Commitear este plan | sí, en la rama / no | Sí, en `feat/track-timeline` como primer commit |

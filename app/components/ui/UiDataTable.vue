<script setup lang="ts" generic="T">
/**
 * UiDataTable — operational data grid (Operations palette).
 *
 * Defined sticky header (border-b), compact rows, solid hover tint,
 * no zebra. Wrapper has a defined border so the table reads as a
 * structural panel, not a floating card.
 *
 * Density modes:
 *   compact (default) — py-1.5, scan-friendly for long lists
 *   comfortable       — py-2.5, easier to read at smaller scales
 *
 * Mobile (< md):
 *   The desktop <table> is hidden and rows render as a stacked
 *   labelled-card list — each row becomes a UiCard with column
 *   labels acting as eyebrows above the cell value. Avoids
 *   horizontal scroll on phones / narrow viewports.
 *
 * Loading: pass `loading` to render shimmer rows.
 * Empty:   when `rows` is empty AND not loading, render the empty
 *          state via the `empty` slot (or a default message).
 *
 * Sticky header: wrap the table in a max-h-[N] container; the
 * thead sticks to the top of the scroll region.
 */
import UiSkeleton from './UiSkeleton.vue'

type Align = 'left' | 'right' | 'center'
type Density = 'compact' | 'comfortable'
type ColumnTone = 'numeric' | 'muted' | 'emphasis'

type Column = {
  id: string
  label: string
  class?: string
  align?: Align
  /** Hide this column in the mobile stacked list (e.g., redundant
   *  identifiers, large free text). Renders only at md+. */
  hideOnMobile?: boolean
  /**
   * Visual tone applied to header + cells in this column.
   *   numeric  — subtle bg-surface-2 fill + tabular-nums + right-align
   *              (auto-applies right align if no explicit align). Use
   *              for currency / counts / metrics so they read as a
   *              numeric strip without zebra row tinting.
   *   muted    — faded foreground (text-muted-foreground). Use for
   *              timestamps, ids, secondary metadata.
   *   emphasis — slightly stronger weight (font-medium → font-semibold).
   */
  tone?: ColumnTone
  /**
   * Sort key for the column. Set to enable click-to-sort on the
   * header. Use the data field name (e.g. 'updated_at'); the parent
   * receives `{ key, dir }` via the `update:sort` event and is
   * responsible for re-querying / re-sorting the rows.
   */
  sortKey?: string
}

type Sort = {
  key: string
  dir: 'asc' | 'desc'
}

const props = withDefaults(
  defineProps<{
    columns: Column[]
    rows: T[]
    loading?: boolean
    /** Show this many skeleton rows when loading. */
    skeletonRows?: number
    /** Stable v-for key on each row. Default: index. */
    rowKey?: (row: T, idx: number) => string | number
    /**
     * Currently-applied sort. v-model:sort-friendly so parent owns
     * the truth; UiDataTable just renders + emits clicks. Pass null
     * for "no sort applied".
     */
    sort?: Sort | null
    /** Row density. */
    density?: Density
    /** Column id rendered as the title in the mobile stacked-card view.
     *  Default: first column. The "title" cell renders without an
     *  eyebrow above, so the row reads as "Name | … other fields …". */
    mobileTitleColumn?: string
  }>(),
  {
    loading: false,
    skeletonRows: 5,
    rowKey: undefined,
    sort: null,
    density: 'compact',
    mobileTitleColumn: undefined,
  },
)

const emit = defineEmits<{
  (e: 'rowClick', row: T): void
  (e: 'update:sort', s: Sort): void
}>()

/** Click on a sortable header — toggle direction or set new key. */
function onHeaderClick(c: Column) {
  if (!c.sortKey) return
  const current = props.sort
  // Same column → flip direction. Different column (or no current
  // sort) → start at desc (most data is newest-first).
  const next: Sort =
    current && current.key === c.sortKey
      ? { key: c.sortKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key: c.sortKey, dir: 'desc' }
  emit('update:sort', next)
}

/** Glyph shown next to the column label based on current sort state. */
function sortGlyph(c: Column): '' | '↑' | '↓' | '↕' {
  if (!c.sortKey) return ''
  if (!props.sort || props.sort.key !== c.sortKey) return '↕'
  return props.sort.dir === 'asc' ? '↑' : '↓'
}

const alignClass: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

const rowPadY: Record<Density, string> = {
  compact: 'py-1.5',
  comfortable: 'py-2.5',
}

// Tone styling — applied to BOTH header cells and body cells of the
// same column. Numeric columns get a subtle slate fill + tabular nums.
const headerToneClass: Record<ColumnTone, string> = {
  numeric: 'bg-[hsl(var(--surface-2))]',
  muted: '',
  emphasis: '',
}
const bodyToneClass: Record<ColumnTone, string> = {
  numeric: 'bg-[hsl(var(--surface-2))] tabular-nums',
  muted: 'text-muted-foreground',
  emphasis: 'font-semibold',
}

function effectiveAlign(c: Column): Align {
  // Numeric columns default to right-align unless caller overrides.
  if (c.align) return c.align
  if (c.tone === 'numeric') return 'right'
  return 'left'
}

function keyFor(row: T, idx: number): string | number {
  if (props.rowKey) return props.rowKey(row, idx)
  return idx
}

// Mobile stacked-list helpers.
const titleColumnId = computed(() => props.mobileTitleColumn ?? props.columns[0]?.id ?? '')
const mobileColumns = computed(() => props.columns.filter((c) => !c.hideOnMobile))
const mobileBodyColumns = computed(() => mobileColumns.value.filter((c) => c.id !== titleColumnId.value))
const titleColumn = computed(() => mobileColumns.value.find((c) => c.id === titleColumnId.value))
</script>

<template>
  <div class="ui-card-flush">
    <!-- Desktop table — hidden on narrow viewports. -->
    <div class="hidden md:block overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead class="sticky top-0 z-10 border-b border-border-strong bg-surface-2">
          <tr>
            <th
              v-for="c in columns"
              :key="c.id"
              :class="[
                'px-3 py-2 text-eyebrow select-none whitespace-nowrap',
                alignClass[effectiveAlign(c)],
                c.tone ? headerToneClass[c.tone] : '',
                c.class ?? '',
                c.sortKey ? 'cursor-pointer hover:text-foreground' : '',
              ]"
              :aria-sort="
                c.sortKey
                  ? sort?.key === c.sortKey
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                  : undefined
              "
              @click="onHeaderClick(c)"
            >
              <span
                :class="[
                  'inline-flex items-baseline gap-1',
                  effectiveAlign(c) === 'right' ? 'flex-row-reverse' : '',
                ]"
              >
                <span>{{ c.label }}</span>
                <span
                  v-if="c.sortKey"
                  :class="[
                    'text-[10px] tabular-nums leading-none',
                    sort?.key === c.sortKey
                      ? 'text-foreground'
                      : 'text-muted-foreground/60',
                  ]"
                  aria-hidden="true"
                >{{ sortGlyph(c) }}</span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <template v-if="loading">
            <tr v-for="n in skeletonRows" :key="`sk-${n}`">
              <td
                v-for="c in columns"
                :key="c.id"
                :class="[
                  'px-3',
                  rowPadY[density],
                  c.tone ? bodyToneClass[c.tone].replace('tabular-nums', '').trim() : '',
                ]"
              >
                <UiSkeleton :class="effectiveAlign(c) === 'right' ? 'ml-auto h-4 w-16' : 'h-4 w-32'" />
              </td>
            </tr>
          </template>
          <template v-else-if="rows.length === 0">
            <tr>
              <td :colspan="columns.length" class="px-3 py-10 text-center">
                <slot name="empty">
                  <p class="text-meta">No rows.</p>
                </slot>
              </td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="(row, idx) in rows"
              :key="keyFor(row, idx)"
              class="transition-colors duration-75 hover:bg-accent"
              @click="emit('rowClick', row)"
            >
              <td
                v-for="c in columns"
                :key="c.id"
                :class="[
                  'px-3 align-middle',
                  c.tone === 'muted' ? '' : 'text-foreground',
                  rowPadY[density],
                  alignClass[effectiveAlign(c)],
                  effectiveAlign(c) === 'right' && !c.tone ? 'tabular-nums' : '',
                  c.tone ? bodyToneClass[c.tone] : '',
                ]"
              >
                <slot :name="`cell-${c.id}`" :row="row" :index="idx" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Mobile stacked card list (<md). The first column (or
         mobileTitleColumn) is the row title; remaining columns render
         as labelled key/value pairs underneath. -->
    <div class="md:hidden">
      <template v-if="loading">
        <div
          v-for="n in skeletonRows"
          :key="`sk-m-${n}`"
          class="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0"
        >
          <UiSkeleton class="h-4 w-2/3" />
          <UiSkeleton class="h-3 w-1/2" />
        </div>
      </template>
      <template v-else-if="rows.length === 0">
        <div class="px-4 py-10 text-center">
          <slot name="empty">
            <p class="text-meta">No rows.</p>
          </slot>
        </div>
      </template>
      <template v-else>
        <div
          v-for="(row, idx) in rows"
          :key="`m-${keyFor(row, idx)}`"
          class="border-b border-border px-4 py-3 last:border-b-0 transition-colors hover:bg-accent"
          @click="emit('rowClick', row)"
        >
          <!-- Title row -->
          <div v-if="titleColumn" class="text-sm font-semibold text-foreground">
            <slot :name="`cell-${titleColumn.id}`" :row="row" :index="idx" />
          </div>
          <!-- Labelled key/value list -->
          <dl
            v-if="mobileBodyColumns.length > 0"
            class="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs"
          >
            <template v-for="c in mobileBodyColumns" :key="`m-${c.id}`">
              <dt class="text-eyebrow self-center">{{ c.label }}</dt>
              <dd
                :class="[
                  'min-w-0',
                  c.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground',
                  effectiveAlign(c) === 'right' || c.tone === 'numeric' ? 'text-right tabular-nums' : '',
                  c.tone === 'emphasis' ? 'font-semibold' : '',
                ]"
              >
                <slot :name="`cell-${c.id}`" :row="row" :index="idx" />
              </dd>
            </template>
          </dl>
        </div>
      </template>
    </div>
    <slot name="footer" />
  </div>
</template>

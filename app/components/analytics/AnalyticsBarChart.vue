<script setup lang="ts">
// Thin wrapper around vue-chartjs's <Bar>. Chart.js controllers + scales
// are registered here once so consumers don't have to repeat the boilerplate.
//
// Lazy-loaded by the analytics page via defineAsyncComponent — keeps the
// ~50 KB chart.js bundle out of the initial page load.
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { computed } from 'vue'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

const props = defineProps<{
  labels: string[]
  values: number[]
  label?: string
  color?: string
}>()

const data = computed(() => ({
  labels: props.labels,
  datasets: [
    {
      label: props.label ?? 'Count',
      data: props.values,
      backgroundColor: props.color ?? '#2F80ED',
      borderRadius: 6,
    },
  ],
}))

const options = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { mode: 'index' as const, intersect: false },
  },
  scales: {
    y: { beginAtZero: true, ticks: { precision: 0 } },
  },
}
</script>

<template>
  <div class="h-64 w-full">
    <Bar :data="data" :options="options" />
  </div>
</template>

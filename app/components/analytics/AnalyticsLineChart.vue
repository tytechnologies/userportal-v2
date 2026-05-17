<script setup lang="ts">
// Lightweight line chart for the "listings created over time" series.
// Same registration approach as AnalyticsBarChart — registers controllers
// here so consumers don't repeat. Lazy-loaded by the analytics page.
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from 'chart.js'
import { computed } from 'vue'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

const props = defineProps<{
  labels: string[]
  values: number[]
  label?: string
}>()

const data = computed(() => ({
  labels: props.labels,
  datasets: [
    {
      label: props.label ?? 'Listings',
      data: props.values,
      fill: true,
      backgroundColor: 'rgba(47, 128, 237, 0.1)',
      borderColor: '#2F80ED',
      tension: 0.35,
      pointRadius: 3,
      pointHoverRadius: 5,
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
    <Line :data="data" :options="options" />
  </div>
</template>

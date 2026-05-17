<template>
  <div class="h-96 md:h-[50vw] lg:h-[19vw] ">
    <Line
      :data="localChartData"
      :options="chartOptions"
      :styles="chartStyle"
      class="h-full"
    />
  </div>
</template>

<script lang="ts" setup>
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
} from 'chart.js'
import { Line } from 'vue-chartjs'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler
)

const props = defineProps({
  chartData: {
    type: Object,
    default: () => ({
      labels: [],
      datasets: []
    })
  }
})

const chartStyle = {
  height: '400px',
  width: '100%'
}

// const chartData = {
//   labels: ['January', 'February', 'March', 'April', 'May', 'June', 'July'],
//   datasets: [
//     {
//       label: 'Sample Data',
//       data: [65, 59, 80, 81, 56, 55, 40],
//       fill: {
//         target: 'origin',
//         above: 'rgba(47, 128, 237, 0.3)',
//       },
//       borderColor: 'rgb(47, 128, 237)',
//       tension: 0.4,
//       pointBackgroundColor: 'rgb(47, 128, 237)'
//     }
//   ]
// }

const localChartData = computed(() => ({
  labels: props.chartData.labels || [],
  datasets: [
      {
        label: 'Sample Data',
        data: props.chartData.datasets || [],
        fill: {
          target: 'origin', 
          above: '#EAF2FD',
        },
        borderColor: '#EAF2FD',
        tension: 0.4,
        pointBackgroundColor: '#EAF2FD',
        pointRadius: 0 // Remove data point bullets
      }
    ]
}))

onMounted(() => {
  console.log('localChartData: ', props.chartData)
})

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    y: {
      beginAtZero: true,
      grid: {
        display: false
      }
    },
    x: {
      grid: {
        display: false
      }
    }
  }
}
</script>

<style>
.chart-container {
  height: 400px;
}
</style>
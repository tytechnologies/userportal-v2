<template>
  <div class="h-[8vw]">
    <Doughnut
      :data="chartData"
      :options="chartOptions"
      :styles="chartStyle"
      class="h-full"
    />
  </div>
</template>

<script lang="ts" setup>
import {
  Chart as ChartJS,
  ArcElement,
  Title,
  Tooltip,
} from 'chart.js'
import { Doughnut } from 'vue-chartjs'

ChartJS.register(
  ArcElement,
  Title,
  Tooltip
)

const props = defineProps({
  totalListings: {
    type: Number,
    default: 0
  },
  forValue: {
    type: Number,
    default: 0
  },
  fullDoughnutLabel: {
    type: String,
    default: "All listings"
  }
})

const chartStyle = {
  height: '400px',
  width: '100%'
}

const chartData = computed(() => ({
  labels: [props.fullDoughnutLabel],
  datasets: [
    {
      data: [props.forValue, props.totalListings - props.forValue],
      backgroundColor: ['#5781eb', 'rgba(47, 128, 237, 0.5)'],
      borderWidth: 0
    }
  ]
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '70%',
  plugins: {
    legend: {
      display: false
    }
  }
}
</script>

<style>
.chart-container {
  height: 400px;
}
</style>
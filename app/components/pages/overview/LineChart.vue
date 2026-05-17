<template>
  <LineChartGenerator
    :chart-options="chartOptions"
    :chart-data="{
      labels: chartData.labels || [],
      datasets: chartData.datasets || fakeData
    }"
    :chart-id="chartId"
    :dataset-id-key="datasetIdKey"
    :plugins="plugins"
    :css-classes="cssClasses"
    :styles="myStyles"
    :width="width"
    :height="height"
  />
</template>

<script>

import { Line as LineChartGenerator } from 'vue-chartjs'

import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  LineElement,
  LinearScale,
  CategoryScale,
  PointElement,
  Filler
} from 'chart.js'

ChartJS.register(
  Title,
  Tooltip,
  //Legend,
  LineElement,
  LinearScale,
  CategoryScale,
  PointElement,
  Filler
)

export default {
  name: 'LineChart',
  components: {
    LineChartGenerator
  },
  props: {
    chartId: {
      type: String,
      default: 'line-chart'
    },
    datasetIdKey: {
      type: String,
      default: 'label'
    },
    width: {
      type: Number,
      default: 400
    },
    height: {
      type: Number,
      default: 400
    },
    cssClasses: {
      default: '',
      type: String
    },
    styles: {
      type: Object,
      default: () => {}
    },
    plugins: {
      type: Array,
      default: () => []
    },
    chartData: {
      type: Object,
      default: () => ({
        labels: [],
        datasets: []
      })
    },
    maxY: {
      type: Number,
      default: 1000
    }
  },
  data() {
    return {      
      fakeData: [
        {
          label: "Dataset 1",
          data: [100, 200, 300, 400, 500],
          borderColor: "rgb(255, 99, 132)",
          backgroundColor: "rgba(255, 0, 0)",
        }
      ],
      chartOptions: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { 
            min: 0,
            max: this.maxY
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              callback: function(val, index, ticks) {
                const countTicks = ticks.length;
                let skip = countTicks >= 8 ? Math.floor(countTicks / 4) : 1;

                if(countTicks >= 16)
                  skip = Math.floor(countTicks / 8);
                                                  
                return index % skip === 0 ? this.getLabelForValue(val) : '';
              }
            }
          }
        }
      }        
    }
  },

  computed: {
    myStyles() {
      return {
        height: `400px`,
        position: 'relative'
      }
    }
  },

  methods: {
    scaleMaxY() {
      let maxY = this.maxY;

      if(maxY > 999) {
        maxY = Math.ceil(maxY / 1000) * 1000;
      }
      else if(maxY > 99) {
        maxY = Math.ceil(maxY / 100) * 100;
      }
      else {
        maxY = Math.ceil(maxY / 10) * 10;
      }

      return maxY;
    }
  }
}
</script>
<template lang="html">
  <div>
      <div class="bg-card px-6 py-4 mb-4">
    <ul class="flex flex-col sm:flex-row md:flex-row lg:flex-row justify-center gap-4">
      <li v-for='(tab, index) in tabs'
        :key='tab.title'
         @click='selectTab(index)'
         :class="{'cursor-pointer':!disabled}">
        <div class="flex font-bold rounded-md px-8 py-2 text-center text-sm" :class="{'bg-primary/10 text-primary':index == selectedIndex, 'bg-muted':index !== selectedIndex }">
           <span class="m-auto select-none"> {{ tab.title }} </span>
        </div>
      </li>
    </ul>
  </div>
    <slot></slot>

  </div>
</template>

<script>
export default {
  props: {
    overrideIndex: {
      default: 0,
    },
    disabled: {
      default: false,
    },
  },
  data() {
    return {
      tabs: [], // all of the tabs
      selectedIndex : this.overrideIndex,
    }
  },
  watch: {
    overrideIndex(index) {      
      this.selectTab(index, true)
    },
  },
  created() {
    this.tabs = this.$children
  },
  mounted() {
    this.selectTab(this.selectedIndex, true)
  },
  methods: {
    selectTab(i, bypass = false) {
      if (!bypass && this.disabled) return true
      this.selectedIndex = i
      // loop over all the tabs
      this.tabs.forEach((tab, index) => {
        tab.isActive = index === i
      })
    },
  },
}
</script>
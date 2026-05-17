<template>
  <div class="
  hi-modal
  inline-block
  align-bottom
  bg-card
  rounded-lg
  text-left
  transform
  transition-all
  sm:my-8 sm:align-middle sm:max-w-5xl sm:w-full
">
    <div class="min-h-3xl flex flex-col">
      <div class="flex px-11 pt-8 pb-6">
        <h3 class="text-xl font-bold">
          Table View Options
        </h3>
        <button type="button" class="
        w-6
        h-6
        rounded-full
        ml-auto
        my-auto
        bg-muted
        hover:bg-muted
        text-center
        cursor-pointer
      " @click="$emit('close')">
          <span class="
          w-4
          h-4
          opacity-50
          hover:text-foreground hover:opacity-100
          block
          mx-auto
        ">
            <Close class="opacity-inherit" :size="16" />
          </span>
        </button>
      </div>

      <div class="flex flex-col flex-1 px-11 pb-9">
        <div class="flex-1 scrollbar-thin scrollbar-thumb-black-10 scrollbar-thumb-rounded-full overflow-y-auto mb-9">
          <div class="h-8 flex mb-2 px-3">
            <span class="text-sm text-muted-foreground/70 font-medium mt-2">Column Properties</span>
            <span class="text-xs text-muted-foreground/70 font-medium ml-auto mt-2.5">Select All</span>
            <input type="checkbox" :checked="isAllChecked" @change="$emit('changeAll', !isAllChecked)"
              class="form-checkbox ml-3 my-auto rounded border-gray-401 border-2 focus:shadow-none focus:ring-0 focus:ring-offset-0 text-primary cursor-pointer" />
          </div>
          <div class="grid grid-cols-2">
            <div v-for="(column, key, index) in columns">
              <div :key="index"
                class="h-8  mb-2 px-3 hover:border-solid hover:border hover:border-gray-3 grid grid-cols-2"
                :class="index % 2 === 0 ? 'bg-muted/30' : 'bg-muted/50'">
                <span>
                  <font-awesome-icon :icon="column['icon']" />
                  <span class="text-sm font-medium mt-2" v-html="column['label']" v-if="column['label']"></span>
                </span>
                
                <input type="checkbox" :checked="column.is_visible" @change="$emit('change', key)"
                  class="form-checkbox ml-auto my-auto rounded border-gray-401 border-2 focus:shadow-none focus:ring-0 focus:ring-offset-0 text-primary cursor-pointer" />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>

</template>

<script>
  export default {
    props: ['columns'],
    computed: {
      isAllChecked() {
        return (
          Object.values(this.columns).filter((column) => column.is_visible)
            .length === Object.values(this.columns).length
        )
      },
    },
  }
</script>
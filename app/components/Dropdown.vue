<template>
  <div class="dropdown relative inline-block text-left w-36 flex-1" v-on-clickaway="close" v-if="columns">
    <button type="button"
      class="w-full flex pl-4 pr-10 leading-8 text-sm font-bold text-foreground focus:outline-none rounded-lg whitespace-nowrap"
      :class="show ? 'bg-primary/10' : 'bg-muted hover:bg-muted'" aria-expanded="true" aria-haspopup="true"
      @click="show = ! show">
      <span class="relative top-0.5">{{ typeof columns[value] === 'object' ? columns[value]['label'] : columns['id']
        }}</span>
      <MenuDown v-if="! show" class="w-6 h-6 absolute right-2 top-1 text-gray-3" />
      <MenuUp v-else class="w-6 h-6 absolute right-2 top-1 text-gray-3" />
    </button>
    <transition enter-active-class="transition ease-out duration-100" enter-from-class="transform opacity-0 scale-95"
      enter-to-class="transform opacity-100 scale-100" leave-active-class="transition ease-in duration-75"
      leave-from-class="transform opacity-100 scale-100" leave-to-class="transform opacity-0 scale-95">
      <div class="origin-top-right absolute right-0 w-full mt-2 rounded-md shadow-lg bg-card focus:outline-none z-10"
        role="menu" aria-orientation="vertical" aria-labelledby="menu-button" tabindex="-1" v-show="show">
        <ul class="py-1" role="none">
          <li v-for="(value, key) in columns" :key="key" class="pt-1.5 pb-0.5 hover:bg-muted">
            <button type="button" class="w-full h-6 px-3 text-sm font-medium text-left"
              @click="$emit('input', key); close();">
              {{ typeof value === 'object' ? value['label'] : value }}
            </button>
          </li>
        </ul>
      </div>
    </transition>
  </div>
</template>

<script>
  import MenuDown from 'vue-material-design-icons/MenuDown.vue';
  import MenuUp from 'vue-material-design-icons/MenuUp.vue';

  export default {
    props: {
      columns: {
        default: null
      },
      value: {
        default: null
      }
    },
    components: { MenuDown, MenuUp },
    data() {
      return {
        show: false
      }
    },
    methods: {
      close() {
        this.show = false;
      }
    }
  }
</script>
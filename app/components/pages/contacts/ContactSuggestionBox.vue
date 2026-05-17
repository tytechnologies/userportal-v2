<template>
    <div class="dropdown relative inline-block text-left w-full" v-on-clickaway="close">
        <transition enter-active-class="transition ease-out duration-100"
            enter-from-class="transform opacity-0 scale-95" enter-to-class="transform opacity-100 scale-100"
            leave-active-class="transition ease-in duration-75" leave-from-class="transform opacity-100 scale-100"
            leave-to-class="transform opacity-0 scale-95">
            <div class="origin-top-right absolute right-0 w-full mt-1 rounded-md shadow-lg bg-card focus:outline-none z-10"
                role="menu" aria-orientation="vertical" aria-labelledby="menu-button" tabindex="-1">
                <ul class="py-1" role="none" v-if="suggestions.length > 0">
                    <li v-for="(value, key) in suggestions" :key="key" class="pt-1.5 pb-0.5 hover:bg-muted">
                        <button type="button" class="w-full h-6 px-3 text-xs sm:text-sm md:text-sm lg:text-sm font-medium text-left"
                            @click="$emit('input', value); close();">
                            {{ value.name }} ({{ value.email }})
                        </button>
                    </li>
                </ul>
                <ul class="py-1" role="none" v-else>
                    <li class="pt-1.5 pb-0.5 px-3 hover:bg-muted">
                        No result found
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
        suggestions: {
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
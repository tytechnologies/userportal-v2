import {directive} from "vue3-click-away";

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('on-clickaway', directive)
})
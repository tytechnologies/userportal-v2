<template>
  <div class="h-8">
    <div class="flex" v-if="!!preview">
      <img
        class="relative bottom-0.5 inline object-cover w-8 h-8 rounded-full mr-2"
        :src="preview"
        alt="Profile image"
      />
      <span class="relative top-1 text-sm text-foreground font-medium mr-2">{{
        previewName
      }}</span>
      <button
        type="button"
        class="w-4 h-4 relative top-1 text-center"
        @click="$emit('input', null)"
      >
        <span
          class="w-4 h-4 opacity-50 hover:text-foreground hover:opacity-100 block mx-auto"
        >
          <Close class="opacity-inherit" :size="16" />
        </span>
      </button>
    </div>
    <label class="flex cursor-pointer" v-else>
      <span class="w-6 h-6 text-primary mr-1.5">
        <Paperclip :size="24" />
      </span>
      <input
        type="file"
        class="hidden"
        @change="fileUpdated"
        accept="image/jpeg,image/png"
      />
      <span class="relative top-1 text-sm text-foreground font-medium"
        >Attach profile image (.jpeg, .png)</span
      >
    </label>
  </div>
</template>

<script>
import Close from 'vue-material-design-icons/Close.vue'
import Paperclip from 'vue-material-design-icons/Paperclip.vue'

export default {
  props: ['value', 'uploadImage'],
  emits: ['uploadImage'],
  components: { Close, Paperclip },
  data() {
    return {
      preview: null,
      previewName: '',
    }
  },
  watch: {
    value(value) {
      if (!value) {
        this.preview = null
      } else if (typeof value !== 'string') {
        const reader = new FileReader()
        reader.readAsDataURL(value)
        reader.onload = () => {
          this.preview = reader.result
          this.previewName = value.name
        }
      } else {
        this.preview = value
        this.previewName = value.split('/').pop()
      }
    },
  },
  methods: {
    fileUpdated(e) {
      console.log('ImageUpload.vue: ', e.target.files[0])
      this.$emit('uploadImage', e.target.files[0])
    },
  },
}
</script>

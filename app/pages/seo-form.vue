<template>
  <div class="h-auto p-4 md:flex md:gap-4">
    <div class="grid w-full md:w-6/12 md:pl-4">
      <h3 class="text-2xl font-black uppercase">Add New Seo</h3>
      <div class="grid w-full gap-4 mb-4">
        <div class="flex gap-4">
          <div class="w-4/12 mb-2">
            <VSelect
              id="division_id"
              v-model="generateUrlForm.division"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="Division"
              :options="generateUrlConfig.division"
              label="name"
              :reduce="(item) => item.id"
              >Division
            </VSelect>
          </div>
          <div class="w-4/12 mb-2">
            <VSelect
              id="category_id"
              v-model="generateUrlForm.category"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="Category"
              :options="generateUrlConfig.category"
              label="name"
              :reduce="(item) => item.id"
              >Category
            </VSelect>
          </div>
          <div class="w-4/12 mb-2">
            <VSelect
              id="type_id"
              v-model="generateUrlForm.type"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="Type"
              :options="generateUrlConfig.types"
              label="name"
              :reduce="(item) => item.id"
              >Type
            </VSelect>
          </div>
        </div>
        <div class="flex gap-4">
          <div class="w-4/12 mb-2">
            <VSelect
              id="city_id"
              v-model="generateUrlForm.city"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="City"
              :options="generateUrlConfig.cities"
              label="name"
              :reduce="(item) => item.id"
              >City
            </VSelect>
          </div>
          <div class="w-4/12 mb-2">
            <VSelect
              id="area_id"
              v-model="generateUrlForm.area"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="Area"
              :options="generateUrlConfig.areas"
              label="name"
              :reduce="(item) => item.id"
              >Area
            </VSelect>
          </div>
          <div class="w-4/12 mb-2">
            <VSelect
              id="building_id"
              v-model="generateUrlForm.building"
              :clearable="false"
              required
              :error="errors.type_id"
              placeholder="Area"
              :options="generateUrlConfig.buildings"
              label="name"
              :reduce="(item) => item.id"
              >Building
            </VSelect>
          </div>
        </div>

        <div class="border-t border-dashed border-border"></div>

        <div class="mb-2">
          <Input
            id="url"
            type="text"
            v-model="form.url"
            required
            :error="errors.url"
            placeholder="URL"
            >URL</Input
          >
        </div>
        <div class="mb-2">
          <Input
            id="keyword"
            type="text"
            v-model="form.keyword"
            required
            :error="errors.keyword"
            placeholder="Meta Title"
            >Meta Title</Input
          >
        </div>

        <div class="mb-2">
          <Input
            id="description"
            type="text"
            textarea
            rows="3"
            required
            v-model="form.description"
            :error="errors.description"
            placeholder="Description"
            >Meta Description</Input
          >
        </div>

        <div class="mb-2 h-44">
          <!-- <TextArea id="page_description" type="text" textarea rows="3"
                  v-model="form.page_description" :error="errors.page_description" :options="editorOptions"
                  placeholder="Page Description">Page Description</TextArea> <span v-if="required" class="text-red">*</span>-->

          <label
            for="pageDescription"
            class="mb-2 text-sm font-bold text-foreground"
          >
            <slot>Page Description</slot>
            <!-- ${!! errors.page_description ? 'bg-transparent border-red ring-0' : 'bg-muted/50 border-border'} -->
          </label>
          <client-only
            ><br />
            <HelperText
              invalid
              v-model="errors.page_description"
              class="left-3"
            />

            <quill-editor
              id="pageDescription"
              v-model="form.page_description"
              :class="{
                'border border-red border-solid': errors.page_description,
              }"
              class="z-50 block w-full p-0 m-0 text-sm font-bold rounded-lg form-input focus:bg-transparent placeholder-gray-3 text-foreground focus-within:border-blue focus-within:ring-0"
              :options="editorOptions"
            />
          </client-only>
        </div>
      </div>
    </div>

    <div class="w-full md:w-6/12">
      <div class="h-auto p-4 bg-card rounded-md">
        <div class="flex gap-4">
          <img
            class="w-auto h-5 my-auto"
            src="https://logos-download.com/wp-content/uploads/2016/02/Google_Logo_2015.png"
            alt="google-logo"
          />
          <div
            class="py-3 border border-solid rounded-full w-90 border-gray-3"
          ></div>
        </div>
        <div class="w-full pl-20 text-sm border-b border-solid border-border">
          <div class="flex gap-2 mt-4">
            <div class="px-2 py-2 border-b-4 border-solid border-primary">
              All
            </div>
            <div class="px-2 py-2">Images</div>
            <div class="px-2 py-2">Videos</div>
            <div class="px-2 py-2">News</div>
            <div class="px-2 py-2">Maps</div>
            <div class="px-2 py-2">More</div>
          </div>
        </div>
        <div class="py-2 pb-3 pl-20 text-sm text-gray-3">
          About 510,000,000 results (0.33 seconds)
        </div>

        <!-- Content -->
        <div class="py-2 pl-20">
          <div class="mb-4">
            <div class="text-sm">
              https://housinginteractive.com.ph
              <span class="text-gray-3">{{
                preview.url || '> url-preview'
              }}</span>
            </div>
            <div class="text-lg uppercase text-primary">
              {{ preview.title.substring(0, 50) || 'meta title preview' }}
            </div>
            <div class="w-10/12 text-sm text-gray-3">
              {{
                preview.description.substring(0, 200) ||
                'meta Description preview'
              }}
            </div>
          </div>

          <div
            class="mb-6"
            v-for="(item, index) in [1, 2, 3, 4, 5]"
            :key="index"
          >
            <div class="w-3/12 h-3 mb-2 bg-muted rounded-sm"></div>
            <div class="w-6/12 h-6 mb-2 bg-muted rounded-sm"></div>
            <div class="w-5/12 h-3 mb-2 bg-muted rounded-sm"></div>
          </div>
        </div>
      </div>
      <div class="float-right py-4">
        <button
          type="button"
          class="rounded-lg w-39 h-9 bg-green hover:bg-green-dark"
          @click="save"
        >
          <span class="inline-block text-white font-bold mt-0.5">Save</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import VSelect from '~/components/NewVSelect.vue'
import Modals from '~/mixins/modals'
import Close from 'vue-material-design-icons/Close.vue'
import Input from '~/components/Input.vue'
import TextArea from '~/components/TextArea.vue'
import Select from '~/components/Select.vue'
import HelperText from '~/components/HelperText'

import { apiRoutes } from '~/contants'
import {
  dismissLoading,
  jsonToFormData,
  showLoading,
  showToast,
} from '~/helpers/helpers'
let cleanForm = null

export default {
  middleware: ['auth'],
  mixins: [Modals],
  components: {
    Close,
    Input,
    TextArea,
    Select,
    VSelect,
    HelperText,
  },
  data() {
    return {
      id: -1,
      preview: {
        url: '',
        title: '',
        description: '',
      },
      generateUrlConfig: {
        division: [
          {
            name: 'Residential',
            id: 1,
          },
          {
            name: 'Commercial',
            id: 2,
          },
        ],
        category: [
          {
            name: 'Sale',
            id: 2,
          },
          {
            name: 'Rent',
            id: 1,
          },
        ],
        types: [],
        cities: [],
        areas: [],
        buildings: [],
      },
      generateUrlForm: {
        division: '',
        category: '',
        type: '',
        city: '',
        area: '',
        building: '',
      },
      lastSelectedDivision: null,
      lastSelectedCity: null,
      isLoading: false,
      form: {
        url: '',
        keyword: '',
        description: '',
        page_description: '',
      },
      errors: {},
      editorOptions: {
        theme: 'snow',
        attributes: {
          height: '170',
          width: '400',
        },
      },
    }
  },
  computed: {
    city() {
      return this.generateUrlForm.city
    },
    area() {
      return this.generateUrlForm.area
    },
  },
  mounted() {
    if (this.$route.query.id) {
      this.id = this.$route.query.id
    }
  },
  watch: {
    form: {
      handler(newValue, oldValue) {
        const { url, keyword, description } = newValue
        const urlArray = url.split('/')
        let urlText = ''
        urlArray.forEach((element) => {
          urlText += `> ${element} `
        })
        this.preview.url = urlText
        this.preview.title = keyword
        this.preview.description = description
      },
      deep: true,
    },
    async id(value) {
      if (value) {
        // prefill form
        if (cleanForm === null) {
          cleanForm = Object.assign({}, this.form)
        }
        if (this.id === -1) {
          Object.keys(cleanForm).forEach((key) => {
            this.form[key] = cleanForm[key]
          })
        } else {
          await showLoading()
          $fetch(apiRoutes['seo.show'].replace('/:id', `/${this.id}`))
            .then((data) => {
              dismissLoading()
              Object.keys(this.form).forEach((key) => {
                this.form[key] = data[key]
              })
            })
            .catch(({ response }) => {
              showToast({ title: 'Something went wrong', icon: 'error' })
              dismissLoading()
            })
        }
        this.errors = {}
      }
    },
    generateUrlForm: {
      handler(response) {
        const { division, area, city } = response
        if (!!division) {
          if (this.lastSelectedDivision !== division) {
            this.isLoading = true
            $fetch(
              apiRoutes['divisions.show'].replace('/:id', `/${division}`)
            ).then(
              (data) => {
                const { types, cities, city } = data
                this.generateUrlForm.type = ''
                this.generateUrlForm.city = ''
                this.generateUrlForm.area = ''
                this.generateUrlForm.building = ''
                this.generateUrlConfig.types = types
                this.generateUrlConfig.cities = cities
                this.lastSelectedDivision = division
                this.isLoading = false
              },
              () => {
                this.isLoading = false
              }
            )
          }
        }
        if (!!city) {
          if (this.lastSelectedCity !== city) {
            this.isLoading = true
            $fetch(apiRoutes['cities.show'].replace('/:id', `/${city}`)).then(
              (data) => {
                this.isLoading = false
                const { areas } = data
                this.generateUrlForm.area = ''
                this.generateUrlConfig.areas = areas
                this.lastSelectedCity = city
              },
              () => {
                this.isLoading = false
              }
            )
          }
        }
        this.generateUrl()
      },
      deep: true,
    },
    city() {
      this.getBuildings()
    },
    area() {
      this.getBuildings()
    },
  },
  methods: {
    save() {
      showLoading()
      this.errors = {}
      const form = Object.assign({}, this.form)
      if (this.id !== -1) {
        form['_method'] = 'PATCH'
      }
      this.isLoading = true
      const url =
        this.id !== -1
          ? apiRoutes['seo.update'].replace('/:id', `/${this.id}`)
          : apiRoutes['seo.store']
      this.$axios
        .$post(url, jsonToFormData(form), {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        })
        .then(() => {
          dismissLoading()
          this.isLoading = false
          showToast({
            title: 'Saved Successfully!',
          })
          this.$router.push({ path: 'seo' })
        })
        .catch(({ response }) => {
          dismissLoading()
          this.isLoading = false
          if (response.status === 422) {
            const errors = response.data.errors
            for (let key in errors) {
              if (errors.hasOwnProperty(key)) {
                errors[key] = errors[key][0]
              }
            }
            this.errors = errors
          } else {
            showToast({
              title: 'Oops. Something went wrong. Please try again later.',
              icon: 'error',
            })
          }
        })
    },
    close() {
      this.generateUrlConfig = {
        division: [
          {
            name: 'Residential',
            id: 1,
          },
          {
            name: 'Commercial',
            id: 2,
          },
        ],
        category: [
          {
            name: 'Sale',
            id: 2,
          },
          {
            name: 'Rent',
            id: 1,
          },
        ],
        types: [],
        cities: [],
        areas: [],
        buildings: [],
      }
      this.generateUrlForm = {
        division: '',
        category: '',
        type: '',
        city: '',
        area: '',
        building: '',
      }
      this.lastSelectedDivision = null
      this.lastSelectedCity = null
      this.isLoading = false
      this.form = {
        url: '',
        keyword: '',
        description: '',
        page_description: '',
      }
      this.errors = {}
      this.$emit('close')
    },

    getBuildings() {
      this.isLoading = true
      const { division, area, city } = this.generateUrlForm
      $fetch(apiRoutes['buildings.filter'], {
        params: {
          division,
          city,
          area,
        },
      }).then(
        (data) => {
          this.isLoading = false
          this.generateUrlForm.building = ''
          this.generateUrlConfig.buildings = data
        },
        () => {
          this.isLoading = false
        }
      )
    },
    generateUrl() {
      const { division, type, category, city, area, building } =
        this.generateUrlForm
      const genDivision = this.generateUrlConfig.division.find(
        (e) => e.id === division
      )
        ? this.generateUrlConfig.division.find((e) => e.id === division).name
        : ''
      const genType = this.generateUrlConfig.types.find((e) => e.id === type)
        ? this.generateUrlConfig.types.find((e) => e.id === type).name
        : ''
      const genCategory = this.generateUrlConfig.category.find(
        (e) => e.id === category
      )
        ? this.generateUrlConfig.category.find((e) => e.id === category).name
        : ''
      const genCity = this.generateUrlConfig.cities.find((e) => e.id === city)
        ? this.generateUrlConfig.cities.find((e) => e.id === city).name
        : ''
      const genArea = this.generateUrlConfig.areas.find((e) => e.id === area)
        ? this.generateUrlConfig.areas.find((e) => e.id === area).name
        : ''
      const genBuilding = this.generateUrlConfig.buildings.find(
        (e) => e.id === building
      )
        ? this.generateUrlConfig.buildings.find((e) => e.id === building).name
        : ''
      let generatedUrl = '/'
      if (!!genDivision && !!genCategory) {
        generatedUrl = `${genDivision}-property-${genCategory}`
      }
      if (!!genType) {
        generatedUrl = `${genType}-${genCategory}`
      }
      if (!!genCity) {
        generatedUrl += `-${genCity}`
      }
      if (!!genArea) {
        generatedUrl += `/${genArea}`
      }
      if (!!genBuilding) {
        generatedUrl += `/${genBuilding}`
      }
      this.form.url = generatedUrl
        .replace(/\s+/g, '-')
        .replace(/\./g, '')
        .toLowerCase()
    },
  },
}
</script>

<style lang="postcss">
.ql-container {
  font-family: inherit;
  @apply text-sm;
}

.ql-editor {
  height: 16rem !important;
}
</style>

<template>
  <div class="mt-4 mb-4">
    <h1 class="mb-4 text-2xl font-bold">Commercial Contracts Generation</h1>
    <div class="mb-4 w-1/4">
      <VSelect
        :model-value="form.contract_id"
        :options="contracts"
        label="name"
        :reduce="(item) => item.id"
      >
        Select Commercial Contract to be Generated
      </VSelect>
    </div>
    <div
      class="max-w-3/4 rounded shadow-lg border-gray-401"
      v-if="form.contract_id == 1"
    >
      <div class="mb-4">
        <div
          class="font-bold text-xl mb-4 flex items-center bg-gray-401 h-12 rounded-sm px-6 py-4"
        >
          Property
        </div>
        <div class="px-6 py-4">
          <label class="text-foreground text-base mb-4"> Property Title </label>
          <div class="mb-4 w-1/2">
            <VSelect
              :model-value="form.property_id"
              :options="properties"
              label="name"
              :reduce="(item) => item.id"
              :error="errors.property_id"
              :clearable="false"
            >
              Please Select a Property
            </VSelect>
          </div>
          <div class="flex flex-wrap -mx-3 mb-6">
            <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
              <label class="text-foreground text-base" for="grid-first-name">
                <p>
                  Property Name / Building Name*
                  <span>for Property's Administrative Office</span>
                </p>
              </label>
              <input
                class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                id="grid-first-name"
                type="text"
              />
            </div>
            <div class="w-full md:w-1/4 px-3">
              <label class="text-foreground text-base" for="grid-last-name">
                Property Price *
              </label>
              <input
                class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                id="grid-first-name"
                type="text"
              />
            </div>
            <div class="w-full md:w-1/4 px-3">
              <label class="text-foreground text-base" for="grid-last-name">
                Property Floor Area *
              </label>
              <input
                class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                id="grid-first-name"
                type="text"
              />
            </div>
          </div>
          <div class="flex flex-wrap -mx-3 mb-6">
            <div class="w-full md:w-1/4 px-3 mb-6 md:mb-0">
              <label class="text-foreground text-base" for="grid-first-name">
                Lease Starting Date *
              </label>
              <input
                class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                id="grid-first-name"
                type="text"
              />
            </div>
            <div class="w-full md:w-1/4 px-3">
              <label class="text-foreground text-base" for="grid-last-name">
                Lease Term *
              </label>
              <div class="mb-4 flex flex-row">
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.term_id"
                    :options="terms"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.term_id"
                    :clearable="false"
                  >
                    Select Term
                  </VSelect>
                </div>
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.date_id"
                    :options="dates"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.date_id"
                    :clearable="false"
                  >
                    Select Duration
                  </VSelect>
                </div>
              </div>
            </div>
            <div class="w-full md:w-1/4 px-3">
              <label class="text-foreground text-base" for="grid-last-name">
                Advance Rental *
              </label>
              <div class="mb-4 flex flex-row">
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.term_id"
                    :options="terms"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.term_id"
                    :clearable="false"
                  >
                    Select Term
                  </VSelect>
                </div>
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.date_id"
                    :options="dates"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.date_id"
                    :clearable="false"
                  >
                    Select Duration
                  </VSelect>
                </div>
              </div>
            </div>
            <div class="w-full md:w-1/4 px-3">
              <label class="text-foreground text-base" for="grid-last-name">
                Security Deposit *
              </label>
              <div class="mb-4 flex flex-row">
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.term_id"
                    :options="terms"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.term_id"
                    :clearable="false"
                  >
                    Select Term
                  </VSelect>
                </div>
                <div class="w-1/2 z-0">
                  <VSelect
                    :model-value="form.date_id"
                    :options="dates"
                    label="name"
                    :reduce="(item) => item.id"
                    :error="errors.date_id"
                    :clearable="false"
                  >
                    Select Duration
                  </VSelect>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        class="max-w-3/4 rounded shadow-lg border-gray-401"
        v-if="(form.contract_id = 1)"
      >
        <div class="mb-4">
          <div
            class="font-bold text-xl mb-4 flex items-center bg-gray-401 h-12 rounded-sm px-6 py-4"
          >
            Lessor Information
          </div>
          <div class="px-6 py-4">
            <div class="flex flex-wrap -mx-3 mb-6">
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Full Name <span class="text-red">*</span></p>
                </label>
                <input
                  class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                  id="grid-first-name"
                  type="text"
                />
              </div>
              <div class="w-full md:w-1/4 px-3">
                <label class="text-foreground text-base" for="grid-last-name">
                  <p>Gender <span class="text-red">*</span></p>
                </label>
                <div class="flex mt-2">
                  <div class="flex items-center mr-4">
                    <input
                      id="inline-radio"
                      type="radio"
                      value=""
                      name="inline-radio-group"
                      class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2"
                    />
                    <label
                      for="inline-radio"
                      class="ml-2 text-lg font-medium text-foreground"
                      >Male</label
                    >
                  </div>
                  <div class="flex items-center mr-4">
                    <input
                      id="inline-2-radio"
                      type="radio"
                      value=""
                      name="inline-radio-group"
                      class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2"
                    />
                    <label
                      for="inline-2-radio"
                      class="ml-2 text-lg font-medium text-foreground"
                      >Female</label
                    >
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-wrap -mx-3 mb-6">
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Nationality <span class="text-red">*</span></p>
                </label>

                <VSelect
                  :model-value="form.contract_id"
                  :options="contracts"
                  label="name"
                  :reduce="(item) => item.id"
                  :error="errors.contract_id"
                  :clearable="false"
                >
                  Select Nationality
                </VSelect>
              </div>
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Status <span class="text-red">*</span></p>
                </label>

                <VSelect
                  :model-value="form.contract_id"
                  :options="contracts"
                  label="name"
                  :reduce="(item) => item.id"
                  :error="errors.contract_id"
                  :clearable="false"
                >
                  Select Status
                </VSelect>
              </div>
              <div class="w-full md:w-full px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Address <span class="text-red">*</span></p>
                </label>

                <input
                  class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                  id="grid-first-name"
                  type="text"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        class="max-w-3/4 rounded shadow-lg border-gray-401"
        v-if="(form.contract_id = 1)"
      >
        <div class="mb-4">
          <div
            class="font-bold text-xl mb-4 flex items-center bg-gray-401 h-12 rounded-sm px-6 py-4"
          >
            Lessee Information
          </div>
          <div class="px-6 py-4">
            <div class="flex flex-wrap -mx-3 mb-6">
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Full Name <span class="text-red">*</span></p>
                </label>
                <input
                  class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                  id="grid-first-name"
                  type="text"
                />
              </div>
              <div class="w-full md:w-1/4 px-3">
                <label class="text-foreground text-base" for="grid-last-name">
                  <p>Gender <span class="text-red">*</span></p>
                </label>
                <div class="flex mt-2">
                  <div class="flex items-center mr-4">
                    <input
                      id="inline-radio"
                      type="radio"
                      value=""
                      name="inline-radio-group"
                      class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2"
                    />
                    <label
                      for="inline-radio"
                      class="ml-2 text-lg font-medium text-foreground"
                      >Male</label
                    >
                  </div>
                  <div class="flex items-center mr-4">
                    <input
                      id="inline-2-radio"
                      type="radio"
                      value=""
                      name="inline-radio-group"
                      class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2"
                    />
                    <label
                      for="inline-2-radio"
                      class="ml-2 text-lg font-medium text-foreground"
                      >Female</label
                    >
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-wrap -mx-3 mb-6">
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Nationality <span class="text-red">*</span></p>
                </label>

                <VSelect
                  :model-value="form.contract_id"
                  :options="contracts"
                  label="name"
                  :reduce="(item) => item.id"
                  :error="errors.contract_id"
                  :clearable="false"
                >
                  Select Nationality
                </VSelect>
              </div>
              <div class="w-full md:w-1/2 px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Status <span class="text-red">*</span></p>
                </label>

                <VSelect
                  :model-value="form.contract_id"
                  :options="contracts"
                  label="name"
                  :reduce="(item) => item.id"
                  :error="errors.contract_id"
                  :clearable="false"
                >
                  Select Status
                </VSelect>
              </div>
              <div class="w-full md:w-full px-3 mb-6 md:mb-0">
                <label class="text-foreground text-base" for="grid-first-name">
                  <p>Address <span class="text-red">*</span></p>
                </label>

                <input
                  class="appearance-none block w-full bg-muted text-foreground border border-destructive rounded py-2 px-3 mb-2 leading-tight focus:outline-none focus:bg-card"
                  id="grid-first-name"
                  type="text"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import VSelect from '~/components/NewVSelect.vue'
export default {
  components: {
    VSelect,
  },

  data() {
    return {
      form: {
        contract_id: 1,
        property_id: null,
        date_id: 1,
        terma_id: null,
      },
      errors: {},
      contracts: [
        {
          id: 1,
          name: 'Select Commercial Contract to be Generated',
        },
        {
          id: 2,
          name: 'Contract of Lease',
        },
      ],
      properties: [
        {
          id: 1,
          name: 'Please Select a Property',
        },
      ],
      dates: [
        {
          id: 1,
          name: 'Month',
        },
        {
          id: 2,
          name: 'Year',
        },
      ],
      terms: [
        {
          id: 1,
          name: '1',
        },
        {
          id: 2,
          name: '2',
        },
        {
          id: 3,
          name: '3',
        },
        {
          id: 4,
          name: '4',
        },
        {
          id: 5,
          name: '5',
        },
        {
          id: 6,
          name: '6',
        },
        {
          id: 7,
          name: '7',
        },
        {
          id: 8,
          name: '8',
        },
        {
          id: 9,
          name: '9',
        },
        {
          id: 10,
          name: '10',
        },
        {
          id: 11,
          name: '11',
        },

        {
          id: 12,
          name: '12',
        },
        {
          id: 13,
          name: 'Others',
        },
      ],
    }
  },
}
</script>

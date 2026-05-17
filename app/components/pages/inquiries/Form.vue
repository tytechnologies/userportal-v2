<template>
    <!-- <div class="p-4 bg-card rounded shadow-lg">    
    <div class="flex items-end justify-center px-4 pt-4 sm:block sm:p-0">      
        <div class="px-6 py-6">
          
            <div class="w-full gap-4 mb-4">
                <div class="mb-2">
                    <Input id="name" type="text" v-model="form.name" required :error="errors.name"
                    placeholder="Name">Name</Input>
                </div>

                <div class="mb-2">
                    <Input id="email" type="email" v-model="form.email" required :error="errors.email"
                    placeholder="Email">Email</Input>
                </div>

                <div class="mb-2">
                    <Input id="phone" type="phone" v-model="form.phone" required :error="errors.phone"
                    placeholder="Phone">Phone</Input>
                </div>
                                
                <div class="mb-2">
                    <div class="pt-2 pl-2 font-bold text-muted-foreground">
                        Message
                    </div>
                    <textarea v-model="form.message" class="w-full p-4 text-sm rounded-md bg-muted/50 focus:border-0 border-border" cols="15"></textarea>
                </div>

                <div class="flex">                
                    <button type="button" class="ml-auto rounded-lg w-39 h-9 bg-green hover:bg-green-dark" @click="save">
                        <span class="inline-block text-white font-bold mt-0.5">Save</span>
                    </button>
                </div>  

            </div>
        </div>
    </div>
    </div> -->
</template>

<script>
import { defineComponent } from 'vue';
import inquiryService from '@/services/inquiry.services'
import Input from "~/components/Input.vue";
import { dismissLoading, showLoading, showSwal, showToast } from "~/helpers/helpers";

export default defineComponent({
    name: 'InquiryForm',

    mixins: [inquiryService],

    components: { Input },

    props: {
        referrerUrl: { type: String },
        model: { type: String },
        modelId: { type: Number }
    },

    data() {
        return {
            form: {
                name: null,
                email: null,
                phone: null,
                message: null,
                referrer: this.referrerUrl,
                model: this.model,
                model_id: this.modelId
            },

            errors: {}
        }
    },

    methods: {
        async save() {
            showLoading();

            const result = await this._store(this.form);

            if (result && result.success) {
                showToast({ title: 'Your enquiry submitted successfully!' })
            }

            this.resetForm();

            dismissLoading();
        },

        resetForm() {
            this.form.name = null;
            this.form.email = null;
            this.form.phone = null;
            this.form.message = null;
        }
    }
})
</script>

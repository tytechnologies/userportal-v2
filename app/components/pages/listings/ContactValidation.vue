<template>
    <div class="px-4 py-4 border-b border-border">

        <div class="w-full border-b border-border">
            <div class="grid grid-cols-2 gap-4 pb-4">
                <div class="items-center">
                    <input id="reason_for_access_1" type="radio" value="updateAvail" v-model="reason_for_access" name="reason_for_access" @change="updateBookViewing(false)" class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2">
                    <label for="reason_for_access_1" class="ml-2 text-sm font-medium text-foreground">Update availability</label>
                </div>
                <div class="items-center">
                    <input id="reason_for_access_2" type="radio" value="viewing" v-model="reason_for_access" name="reason_for_access" @change="updateBookViewing(true)" class="w-4 h-4 text-primary bg-muted border-border focus:ring-ring focus:ring-2">
                    <label for="reason_for_access_2" class="ml-2 text-sm font-medium text-foreground">Book a viewing</label>
                </div>
            </div>
            <div class="pb-4 border-b border-border" v-show="book_a_viewing">
                <Input id="refID" placeholder="Reference ID" v-model="refID" type="text">Reference ID</Input>
            </div>
        </div>

        <div class="flex justify-end pt-4">
            <button type="button" class="rounded-lg w-39 h-9 bg-green" @click="historyLog()">
                <span class="inline-block text-white font-bold mt-0.5">Update</span>
            </button>
        </div>

    </div>
</template>

<script>
import Close from 'vue-material-design-icons/Close';
import Input from '@/components/Input'
import listingService from '@/services/listing.services'

export default {
    props: {
        listingId: Number
    },
    mixins: [listingService],
    data(){
        return {
            book_a_viewing: false,
            reason_for_access: 'updateAvail',
            refID: null
        }
    },  
    components: { Close, Input },
    methods: {
        updateBookViewing(value){
            this.book_a_viewing = value
        },

        async historyLog(){
            let params = {
                event: this.reason_for_access,
                refID: this.refID
            }
            // WIP
            // this._historyLog(this.listingId, params)
            this.$emit('toggleContactValidation');
        },

    },
    mounted(){}
}
</script>
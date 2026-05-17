
<template>
    <div class="w-full">
        <div class="md:w-full lg:max-w-4xl flex flex-col mx-auto pb-24 p-8">
            <div class="mx-auto">
                <img class="object-scale-down mb-20" src="/img/cityscapes.png" alt="Cityscapes">
            </div>
            <h1 class="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold mx-auto text-center">Delivering Property Solutions for 20 years</h1>
            <p class="max-w-3xl text-base lg:text-2xl mx-auto text-center font-medium text-gray-350">Home of the first online property listing platform in the Philippines</p>
            <!-- <ul class="flex flex-wrap mx-auto my-12">
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
                <li class="mx-7 sm:mx-3 md:mx-3 my-4"><img class="object-scale-down" src="/img/cnn.png" alt="CNN"></li>
            </ul> -->
            <div class="mx-auto my-12">
                <img class="drop-shadow-3xl rounded-md" src="/img/wireframe.jpg" alt="Wireframe">
            </div>
            <div class="flex flex-wrap justify-center mx-auto gap-8 text-center py-24">
                <div class="font-bold flex flex-col">
                    <span class="text-5xl block">7,319</span>
                    <span class="text-base">Total Contracts</span>
                </div>
                <div class="font-bold flex flex-col">
                    <span class="text-5xl block">3,462</span>
                    <span class="text-base">Residential list <br /> brokers</span>
                </div>
                <div class="font-bold flex flex-col">
                    <span class="text-5xl block">857</span>
                    <span class="text-base">Commercial list <br /> brokers</span>
                </div>
                <div class="font-bold flex flex-col">
                    <span class="text-5xl block">3,000</span>
                    <span class="text-base">Client report</span>
                </div>
            </div>
            <div class="flex flex-wrap sm:flex-nowrap text-xl w-full gap-6 mb-8">
                <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
                    <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
                    <h3 class="text-xl font-bold my-4">List your property with confidence</h3>
                    <p class="text-base font-medium text-muted-foreground/70">Post your properties on our website and across our affiliate marketplaces exclusively. We honor a first-come, first-served basis thus we do not allow duplicate listings of the same property. Once you have successfully listed your property with us, we ensure that you are the sole listing agent of your property.</p>
                </div>
                <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
                    <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
                    <h3 class="text-xl font-bold my-4">Get pre-qualified inquiries about your property</h3>
                    <p class="text-base font-medium text-muted-foreground/70">Whenever your property receives an inquiry, our team will pre-qualify them first before passing them on to you to ensure that these leads are warm, high-quality, and highly interested in your listing.</p>
                </div>
            </div>
            <div class="flex flex-wrap sm:flex-nowrap w-full gap-6">
                <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
                    <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
                    <h3 class="text-xl font-bold my-4">Negotiate and deal with leads</h3>
                    <p class="text-base font-medium text-muted-foreground/70">We will assign one in-house Pro broker to your property and ensure that everything is streamlined and no feedback is lost in communication. The assigned Pro broker shall facilitate the transaction from start to finish until you close the deal with the client.</p>
                </div>
                <div class="w-full sm:w-1/2 md:w-1/2 lg:w-1/2">
                    <!-- <span class="block w-20 h-20 bg-muted rounded-full mx-auto sm:m-0 md:m-0 lg:m-0">&nbsp;</span> -->
                    <h3 class="text-xl font-bold my-4">Receive sales and commission</h3>
                    <p class="text-base font-medium text-muted-foreground/70">Our team shall facilitate with you along with the client to close the transaction and complete all necessary documents. Once a transaction is fulfilled, the listing agents shall receive the agreed commission, and/or the listing owners shall receive the sales/rentals for the property.</p>
                </div>
            </div>

        </div>
        <Footer />
    </div>

</template>

<script>
import Footer from '~/components/Footer'

export default {
    components: { Footer },
}
</script>
